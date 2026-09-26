import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../../context.js";
import { stores } from "../../db/schema.js";
import { audit } from "../../lib/audit.js";
import { HttpError } from "../../lib/errors.js";
import { enqueueOrderSync } from "../../jobs/handlers.js";
import { requireAuth } from "../../modules/auth.js";
import { connectShopifyStore } from "../../modules/stores.js";
import { adapterFor } from "../index.js";
import { normalizeShopDomain } from "./client.js";

/**
 * Public-app install flow (authorization code grant) + app webhooks.
 * Needs SHOPIFY_API_KEY / SHOPIFY_API_SECRET and the app's redirect URL set
 * to `${APP_URL}/api/shopify/callback`.
 */

const STATE_TTL_MS = 10 * 60_000;

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function requireApp(deps: Deps) {
  const { apiKey, apiSecret } = deps.config.shopify;
  if (!apiKey || !apiSecret) {
    throw new HttpError(400, "服务端未配置 Shopify App（SHOPIFY_API_KEY / SECRET）", "shopify_app_missing");
  }
  return { apiKey, apiSecret };
}

/** State binds the callback to the workspace that started the install. */
function signState(secret: string, workspaceId: string) {
  const payload = Buffer.from(
    JSON.stringify({ w: workspaceId, n: randomBytes(8).toString("hex"), e: Date.now() + STATE_TTL_MS }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readState(secret: string, state: string): string | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  const { w, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    w: string;
    e: number;
  };
  return e > Date.now() ? w : null;
}

/** Shopify signs callback query params: sorted k=v joined by &, minus hmac. */
export function verifyQueryHmac(secret: string, params: URLSearchParams): boolean {
  const hmac = params.get("hmac");
  if (!hmac) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", secret).update(message).digest("hex");
  return safeEqual(digest, hmac);
}

export function shopifyAppRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/install", requireAuth, (c) => {
    const deps = c.var.deps;
    const { apiKey, apiSecret } = requireApp(deps);
    const shop = normalizeShopDomain(c.req.query("shop") ?? "");
    if (!shop) throw new HttpError(400, "店铺域名格式应为 xxx.myshopify.com");
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.searchParams.set("client_id", apiKey);
    url.searchParams.set("scope", deps.config.shopify.scopes);
    url.searchParams.set("redirect_uri", `${deps.config.appUrl}/api/shopify/callback`);
    url.searchParams.set("state", signState(apiSecret, c.var.auth.workspaceId));
    return c.json({ url: url.toString() });
  });

  r.get("/callback", async (c) => {
    const deps = c.var.deps;
    const { apiKey, apiSecret } = requireApp(deps);
    const params = new URL(c.req.url).searchParams;
    const shop = normalizeShopDomain(params.get("shop") ?? "");
    const code = params.get("code");
    const workspaceId = readState(apiSecret, params.get("state") ?? "");
    if (!shop || !code || !workspaceId || !verifyQueryHmac(apiSecret, params)) {
      throw new HttpError(400, "Shopify 回调校验失败");
    }
    const res = await deps.fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    if (!res.ok) throw new HttpError(502, `Shopify 换取令牌失败 HTTP ${res.status}`);
    const token = (await res.json()) as { access_token: string; scope?: string };
    const store = await connectShopifyStore(deps, workspaceId, shop, {
      kind: "oauth",
      accessToken: token.access_token,
      scope: token.scope,
    });
    // oauth 店注册订单 webhook（手动 token 店没有我们的 app secret，只能轮询）。
    // 注册失败不阻塞连接——增量轮询仍在兜底。
    const adapter = adapterFor(store.platform);
    if (adapter.registerOrderWebhooks) {
      try {
        const res = await adapter.registerOrderWebhooks(
          deps,
          store,
          `${deps.config.appUrl}/api/shopify/webhooks`,
        );
        if (res.errors.length || res.registered.length < 3) {
          await audit(deps.db, workspaceId, {
            actor: "system",
            action: "order.webhooks_partial",
            entityType: "store",
            entityId: store.id,
            payload: { registered: res.registered, errors: res.errors },
          });
        }
      } catch (e) {
        await audit(deps.db, workspaceId, {
          actor: "system",
          action: "order.webhooks_failed",
          entityType: "store",
          entityId: store.id,
          payload: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
    return c.redirect(`${deps.config.appUrl}/stores?connected=${encodeURIComponent(shop)}`);
  });

  /**
   * app/uninstalled + mandatory privacy webhooks + 订单 topics。
   * 订单 webhook 只入队不处理报文：worker 内按 remoteId 拉最新单（payload 会过期）。
   * 手动 token 店的 webhook 用商家自建应用 secret 签，这里验签不了 → 那类店只靠轮询。
   */
  r.post("/webhooks", async (c) => {
    const deps = c.var.deps;
    const { apiSecret } = requireApp(deps);
    const raw = await c.req.text();
    const given = c.req.header("x-shopify-hmac-sha256") ?? "";
    const digest = createHmac("sha256", apiSecret).update(raw, "utf8").digest("base64");
    if (!safeEqual(digest, given)) return c.text("unauthorized", 401);
    const topic = c.req.header("x-shopify-topic");
    const shop = c.req.header("x-shopify-shop-domain");
    if (topic === "app/uninstalled" && shop) {
      await deps.db
        .update(stores)
        .set({ status: "disconnected", lastError: "应用已从店铺卸载" })
        .where(eq(stores.shopDomain, shop));
    } else if (
      shop &&
      topic &&
      ["orders/create", "orders/updated", "orders/cancelled"].includes(topic)
    ) {
      const [store] = await deps.db
        .select()
        .from(stores)
        .where(eq(stores.shopDomain, shop))
        .limit(1);
      if (store) {
        // 只取 gid 做定向同步；拿不到就退全店增量（报文本体绝不进 worker）
        let remoteId: string | undefined;
        try {
          const id = (JSON.parse(raw) as { admin_graphql_api_id?: string })
            .admin_graphql_api_id;
          if (typeof id === "string" && id) remoteId = id;
        } catch {
          /* fall through to incremental */
        }
        await enqueueOrderSync(deps.db, store.id, store.workspaceId, remoteId);
      }
    }
    return c.text("ok");
  });

  return r;
}
