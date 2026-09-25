import { eq } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { stores } from "../../db/schema.js";
import { ChannelError, type StoreRow } from "../types.js";

export type ShopifyCredentials =
  | { kind: "access_token"; accessToken: string }
  | { kind: "oauth"; accessToken: string; scope?: string }
  | {
      kind: "client_credentials";
      clientId: string;
      clientSecret: string;
      accessToken?: string;
      /** epoch ms */
      expiresAt?: number;
    };

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** "my-shop" | "my-shop.myshopify.com" | "https://my-shop.myshopify.com/admin" → "my-shop.myshopify.com" */
export function normalizeShopDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  return SHOP_DOMAIN_RE.test(s) ? s : null;
}

/** fetch that turns network failures into user-readable, retryable errors. */
async function shopFetch(deps: Deps, shopDomain: string, url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await deps.fetch(url, init);
  } catch {
    throw new ChannelError(`无法连接店铺 ${shopDomain}（网络异常或域名不存在）`, false);
  }
  if (res.status === 404) {
    throw new ChannelError(`店铺 ${shopDomain} 不存在，请检查域名`);
  }
  return res;
}

/** Client-credentials grant (Dev Dashboard apps): 24h tokens, fetched on demand. */
export async function fetchClientCredentialsToken(
  deps: Deps,
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const res = await shopFetch(deps, shopDomain, `https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new ChannelError(
      `Shopify 换取令牌失败（HTTP ${res.status}），请检查 Client ID / Secret 以及应用是否已安装到该店铺`,
    );
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 86399) * 1000,
  };
}

async function accessTokenFor(deps: Deps, store: StoreRow): Promise<string> {
  const creds = deps.secrets.open<ShopifyCredentials>(store.credentials);
  if (creds.kind !== "client_credentials") return creds.accessToken;
  if (creds.accessToken && (creds.expiresAt ?? 0) - Date.now() > 5 * 60_000) {
    return creds.accessToken;
  }
  const fresh = await fetchClientCredentialsToken(
    deps,
    store.shopDomain,
    creds.clientId,
    creds.clientSecret,
  );
  await deps.db
    .update(stores)
    .set({ credentials: deps.secrets.seal({ ...creds, ...fresh }) })
    .where(eq(stores.id, store.id));
  return fresh.accessToken;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/** Admin GraphQL call with throttle-aware retry. */
export async function shopifyGraphql<T>(
  deps: Deps,
  store: StoreRow,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = await accessTokenFor(deps, store);
  const url = `https://${store.shopDomain}/admin/api/${deps.config.shopify.apiVersion}/graphql.json`;
  for (let attempt = 0; ; attempt++) {
    const res = await shopFetch(deps, store.shopDomain, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ChannelError("Shopify 拒绝访问：令牌无效或缺少权限（需要 write_products）");
    }
    if (res.status === 402) throw new ChannelError("店铺已冻结或未付费（Shopify 402）");
    const throttled = res.status === 429;
    const body = throttled
      ? null
      : ((await res.json().catch(() => null)) as GraphqlResponse<T> | null);
    const gqlThrottled = body?.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if ((throttled || gqlThrottled) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (throttled || gqlThrottled) throw new ChannelError("Shopify 限流，稍后重试", false);
    if (res.status >= 500) throw new ChannelError(`Shopify 服务异常 HTTP ${res.status}`, false);
    if (body?.errors?.length) {
      throw new ChannelError(body.errors.map((e) => e.message).join("; "));
    }
    if (!body?.data) throw new ChannelError(`Shopify 返回异常 HTTP ${res.status}`, false);
    return body.data;
  }
}
