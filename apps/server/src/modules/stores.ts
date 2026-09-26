import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { PricingRule, Store, StoreRules } from "@caiji/shared";
import { adapterFor } from "../channels/index.js";
import {
  fetchClientCredentialsToken,
  normalizeShopDomain,
  type ShopifyCredentials,
} from "../channels/shopify/client.js";
import { ChannelError, type StoreRow } from "../channels/types.js";
import type { AppEnv, Deps } from "../context.js";
import { stores } from "../db/schema.js";
import { DEFAULT_PRICING } from "../lib/draft.js";
import { HttpError, notFound } from "../lib/errors.js";
import { enqueueCategorySync, enqueueStoreSync } from "../jobs/handlers.js";
import { cachedCategoryAttributes } from "../lib/attributes.js";
import { searchCachedCategories } from "../lib/category.js";
import { requireAuth } from "./auth.js";

export function toStoreDto(r: StoreRow): Store {
  return {
    id: r.id,
    platform: r.platform,
    name: r.name,
    shopDomain: r.shopDomain,
    authType: r.authType,
    status: r.status,
    currency: r.currency,
    pricing: { ...DEFAULT_PRICING, ...r.pricing },
    vendor: r.vendor,
    aiEnhance: r.aiEnhance === "on",
    language: r.language,
    rules: r.rules ?? {},
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Verify credentials against the shop, then insert or refresh the store row.
 * Shared by manual connect and the OAuth callback.
 */
export async function connectShopifyStore(
  deps: Deps,
  workspaceId: string,
  shopDomain: string,
  creds: ShopifyCredentials,
): Promise<StoreRow> {
  // Verify with a transient row before persisting anything.
  const probe = {
    id: "00000000-0000-0000-0000-000000000000",
    shopDomain,
    credentials: deps.secrets.seal(creds),
  } as StoreRow;
  let info;
  try {
    info = await adapterFor("shopify").verify(deps, probe);
  } catch (e) {
    if (e instanceof ChannelError) throw new HttpError(422, e.message, "shop_verify_failed");
    throw e;
  }
  const sealed = deps.secrets.seal(creds);
  const [row] = await deps.db
    .insert(stores)
    .values({
      workspaceId,
      platform: "shopify",
      name: info.name,
      shopDomain,
      authType: creds.kind,
      credentials: sealed,
      currency: info.currency,
      pricing: DEFAULT_PRICING,
    })
    .onConflictDoUpdate({
      target: [stores.workspaceId, stores.platform, stores.shopDomain],
      set: {
        name: info.name,
        authType: creds.kind,
        credentials: sealed,
        currency: info.currency,
        status: "active",
        lastError: null,
      },
    })
    .returning();
  // 建店后排一次类目树同步（adapter 不支持时 worker 侧直接跳过）
  await enqueueCategorySync(deps.db, row!.id, workspaceId);
  return row!;
}

const connectSchema = z.discriminatedUnion("authType", [
  z.object({
    authType: z.literal("access_token"),
    shopDomain: z.string().min(1),
    accessToken: z.string().trim().min(10),
  }),
  z.object({
    authType: z.literal("client_credentials"),
    shopDomain: z.string().min(1),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
  }),
]);

/** 与刊登模板共用：模板 payload 必须能通过店铺 PATCH 的同一套校验。 */
export const pricingSchema = z.object({
  exchangeRate: z.number().positive().max(1000),
  markup: z.number().positive().max(100),
  priceEnding: z.number().min(0).max(0.99).nullable(),
  extraCostCny: z.number().min(0).max(100_000).default(0),
  minPrice: z.number().min(0).max(1_000_000).nullable().default(null),
}) satisfies z.ZodType<PricingRule>;

const SUGGESTION_FIELDS = [
  "title",
  "descriptionHtml",
  "productType",
  "tags",
  "options",
  "category",
  "attributes",
] as const;

export const pipelinePolicySchema = z
  .object({
    autoClaim: z.boolean().optional(),
    autoAcceptFields: z.array(z.enum(SUGGESTION_FIELDS)).max(7).optional(),
    holdPoint: z.enum(["after_ai", "after_precheck", "auto"]).optional(),
    autoPublish: z.boolean().optional(),
    publishMode: z.enum(["now", "scheduled", "paced"]).optional(),
    publishAt: z.iso.datetime({ offset: true }).optional(),
    paceMinutes: z.number().min(1).max(24 * 60).optional(),
    holdOnWarning: z.boolean().optional(),
    disabledStages: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  })
  .optional();

export const inventoryRulesSchema = z
  .object({
    strategy: z.enum(["mirror", "fixed", "percent", "cap"]).optional(),
    fixedQty: z.number().int().min(0).max(999_999).optional(),
    percent: z.number().min(0).max(10_000).optional(),
    cap: z.number().int().min(0).max(999_999).optional(),
    buffer: z.number().int().min(0).max(999_999).optional(),
    oosAction: z.enum(["zero", "unpublish", "notify"]).optional(),
  })
  .optional();

export const monitorRulesSchema = z
  .object({
    enabled: z.boolean().optional(),
    minStock: z.number().int().min(0).max(999_999).optional(),
    priceAuto: z.boolean().optional(),
  })
  .optional();

export const rulesSchema = z.object({
  titlePrefix: z.string().trim().max(100).optional(),
  titleSuffix: z.string().trim().max(100).optional(),
  replacements: z
    .array(z.object({ from: z.string().min(1).max(255), to: z.string().max(255) }))
    .max(200)
    .optional(),
  priceMinCny: z.number().min(0).max(10_000_000).nullable().optional(),
  priceMaxCny: z.number().min(0).max(10_000_000).nullable().optional(),
  maxImages: z.number().int().min(1).max(20).nullable().optional(),
  bannedWords: z.array(z.string().trim().min(1).max(100)).max(500).optional(),
  publishStatus: z.enum(["active", "draft"]).optional(),
  trackStock: z.boolean().optional(),
  inventoryLocationId: z.string().max(100).optional(),
  defaultTags: z.array(z.string().trim().min(1).max(255)).max(50).optional(),
  defaultProductType: z.string().trim().max(255).optional(),
  defaultWeightKg: z.number().min(0).max(100_000).optional(),
  pipeline: pipelinePolicySchema,
  inventory: inventoryRulesSchema,
  monitor: monitorRulesSchema,
}) satisfies z.ZodType<StoreRules>;

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  pricing: pricingSchema.optional(),
  vendor: z.string().trim().max(255).optional(),
  aiEnhance: z.boolean().optional(),
  language: z.string().trim().min(2).max(32).optional(),
  rules: rulesSchema.optional(),
});

export function storeRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(stores)
      .where(eq(stores.workspaceId, c.var.auth.workspaceId))
      .orderBy(asc(stores.createdAt));
    return c.json(rows.map(toStoreDto));
  });

  /** Manual connect: legacy admin token, or Dev Dashboard client credentials. */
  r.post("/shopify", zValidator("json", connectSchema), async (c) => {
    const deps = c.var.deps;
    const body = c.req.valid("json");
    const shopDomain = normalizeShopDomain(body.shopDomain);
    if (!shopDomain) throw new HttpError(400, "店铺域名格式应为 xxx.myshopify.com");
    let creds: ShopifyCredentials;
    if (body.authType === "access_token") {
      creds = { kind: "access_token", accessToken: body.accessToken };
    } else {
      let token;
      try {
        token = await fetchClientCredentialsToken(
          deps,
          shopDomain,
          body.clientId,
          body.clientSecret,
        );
      } catch (e) {
        if (e instanceof ChannelError) throw new HttpError(422, e.message);
        throw e;
      }
      creds = {
        kind: "client_credentials",
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        ...token,
      };
    }
    const row = await connectShopifyStore(deps, c.var.auth.workspaceId, shopDomain, creds);
    return c.json(toStoreDto(row), 201);
  });

  r.patch("/:id", zValidator("json", patchSchema), async (c) => {
    const { aiEnhance, ...rest } = c.req.valid("json");
    const [row] = await c.var.deps.db
      .update(stores)
      .set({ ...rest, ...(aiEnhance === undefined ? {} : { aiEnhance: aiEnhance ? "on" : "off" }) })
      .where(
        and(eq(stores.id, c.req.param("id")), eq(stores.workspaceId, c.var.auth.workspaceId)),
      )
      .returning();
    if (!row) throw notFound("店铺");
    return c.json(toStoreDto(row));
  });

  /** Re-verify credentials (e.g. after the merchant reinstalls the app). */
  r.post("/:id/verify", async (c) => {
    const deps = c.var.deps;
    const [store] = await deps.db
      .select()
      .from(stores)
      .where(
        and(eq(stores.id, c.req.param("id")), eq(stores.workspaceId, c.var.auth.workspaceId)),
      );
    if (!store) throw notFound("店铺");
    let patch: Partial<StoreRow>;
    try {
      const info = await adapterFor(store.platform).verify(deps, store);
      patch = { status: "active", lastError: null, name: info.name, currency: info.currency };
    } catch (e) {
      if (!(e instanceof ChannelError)) throw e;
      patch = { status: "error", lastError: e.message };
    }
    const [row] = await deps.db
      .update(stores)
      .set(patch)
      .where(eq(stores.id, store.id))
      .returning();
    return c.json(toStoreDto(row!));
  });

  /** Pull channel-side product status back now (also runs on a schedule). */
  r.post("/:id/sync", async (c) => {
    const [store] = await c.var.deps.db
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(eq(stores.id, c.req.param("id")), eq(stores.workspaceId, c.var.auth.workspaceId)),
      );
    if (!store) throw notFound("店铺");
    await enqueueStoreSync(c.var.deps.db, store.id, c.var.auth.workspaceId);
    return c.json({ queued: true });
  });

  /** 拉取平台全量类目树到本地缓存（手动选类目 / 属性映射的基础）。 */
  r.post("/:id/sync-categories", async (c) => {
    const [store] = await c.var.deps.db
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(eq(stores.id, c.req.param("id")), eq(stores.workspaceId, c.var.auth.workspaceId)),
      );
    if (!store) throw notFound("店铺");
    await enqueueCategorySync(c.var.deps.db, store.id, c.var.auth.workspaceId);
    return c.json({ queued: true });
  });

  /** 类目搜索：先查本地类目缓存，缓存没数据再走平台实时搜索。 */
  r.get("/:id/categories", async (c) => {
    const deps = c.var.deps;
    const [store] = await deps.db
      .select()
      .from(stores)
      .where(
        and(eq(stores.id, c.req.param("id")), eq(stores.workspaceId, c.var.auth.workspaceId)),
      );
    if (!store) throw notFound("店铺");
    const q = c.req.query("q") ?? "";
    const local = await searchCachedCategories(deps.db, store.platform, q);
    if (local.length || !q.trim()) return c.json({ items: local });
    const adapter = adapterFor(store.platform);
    const items = adapter.searchCategories
      ? await adapter.searchCategories(deps, store, q)
      : [];
    return c.json({ items });
  });

  /** 店铺库存地点列表（库存写入地点选择的下拉数据源）。 */
  r.get("/:id/locations", async (c) => {
    const deps = c.var.deps;
    const [store] = await deps.db
      .select()
      .from(stores)
      .where(
        and(eq(stores.id, c.req.param("id")), eq(stores.workspaceId, c.var.auth.workspaceId)),
      );
    if (!store) throw notFound("店铺");
    const adapter = adapterFor(store.platform);
    const items = adapter.listLocations
      ? await adapter.listLocations(deps, store)
      : [];
    return c.json({ items });
  });

  /** 类目标准属性（懒拉取并缓存进 channel_categories.attributesSchema）。 */
  r.get("/:id/categories/:categoryId/attributes", async (c) => {
    const deps = c.var.deps;
    const [store] = await deps.db
      .select()
      .from(stores)
      .where(
        and(eq(stores.id, c.req.param("id")), eq(stores.workspaceId, c.var.auth.workspaceId)),
      );
    if (!store) throw notFound("店铺");
    const categoryId = decodeURIComponent(c.req.param("categoryId"));
    const items = await cachedCategoryAttributes(deps.db, deps, store, categoryId);
    return c.json({ items });
  });

  r.delete("/:id", async (c) => {
    const [row] = await c.var.deps.db
      .delete(stores)
      .where(
        and(eq(stores.id, c.req.param("id")), eq(stores.workspaceId, c.var.auth.workspaceId)),
      )
      .returning({ id: stores.id });
    if (!row) throw notFound("店铺");
    return c.json({ ok: true });
  });

  return r;
}
