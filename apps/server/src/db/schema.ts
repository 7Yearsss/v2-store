import type {
  ChannelAttribute,
  ListingChannelAttribute,
  ListingOption,
  ListingVariant,
  OfferSku,
  PricingRule,
  RemoteStatus,
  StoreRules,
  StoreSettingsPayload,
} from "@caiji/shared";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// --- identity & tenancy -----------------------------------------------------

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

/** Tenant. Every business row hangs off a workspace; billing attaches here. */
export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

/** Opaque bearer sessions; only the SHA-256 of the token is stored. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["web", "extension"] }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// --- collect box ------------------------------------------------------------

/** 采集箱：采集来的货源原料（未加工、未认领）。 */
export const sourceItems = pgTable(
  "source_items",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourcePlatform: text("source_platform").notNull(),
    sourceUrl: text("source_url").notNull(),
    /** platform-native id (1688 offerId); dedup key when present. */
    sourceItemId: text("source_item_id"),
    title: text("title").notNull(),
    priceText: text("price_text"),
    skus: jsonb("skus").$type<OfferSku[]>().notNull().default([]),
    images: jsonb("images").$type<string[]>().notNull().default([]),
    /** 详情区长图（1688 详情 tab DOM/descUrl 采集，认领进刊登，发布进描述）。 */
    descImages: jsonb("desc_images").$type<string[]>().notNull().default([]),
    attributes: jsonb("attributes")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    sellerName: text("seller_name"),
    /** 来源平台叶子类目（1688 leafCategoryId / leafCategoryName）。 */
    sourceCategoryId: text("source_category_id"),
    sourceCategoryName: text("source_category_name"),
    collectedBy: uuid("collected_by").references(() => users.id, {
      onDelete: "set null",
    }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("source_items_ws_platform_item_uq")
      .on(t.workspaceId, t.sourcePlatform, t.sourceItemId)
      .where(sql`${t.sourceItemId} is not null`),
    uniqueIndex("source_items_ws_url_uq").on(t.workspaceId, t.sourceUrl),
    index("source_items_ws_collected_idx").on(t.workspaceId, t.collectedAt),
  ],
);

// --- media ------------------------------------------------------------------

/** 我们自己保存的图片（按内容哈希去重）。bytes live in the BlobStore. */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("media_assets_ws_sha_uq").on(t.workspaceId, t.sha256)],
);

/** Source image URL → our copy. Source URLs stay the identity in item data. */
export const mediaSources = pgTable(
  "media_sources",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.sourceUrl] })],
);

// --- channels ---------------------------------------------------------------

/** 授权店铺。credentials is AES-GCM ciphertext (see lib/crypto). */
export const stores = pgTable(
  "stores",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: ["shopify"] }).notNull(),
    name: text("name").notNull(),
    shopDomain: text("shop_domain").notNull(),
    authType: text("auth_type", {
      enum: ["oauth", "client_credentials", "access_token"],
    }).notNull(),
    credentials: text("credentials").notNull(),
    status: text("status", { enum: ["active", "error", "disconnected"] })
      .notNull()
      .default("active"),
    currency: text("currency"),
    pricing: jsonb("pricing").$type<PricingRule>().notNull(),
    vendor: text("vendor").notNull().default(""),
    /** AI pipeline runs on claim when true (store settings opt-out). */
    aiEnhance: text("ai_enhance", { enum: ["on", "off"] })
      .notNull()
      .default("on"),
    /** target language for AI-rewritten listing content. */
    language: text("language").notNull().default("en"),
    /** 采集预处理 + 发布前检查规则。 */
    rules: jsonb("rules").$type<StoreRules>().notNull().default({}),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("stores_ws_platform_domain_uq").on(
      t.workspaceId,
      t.platform,
      t.shopDomain,
    ),
  ],
);

/** 刊登草稿/在线商品：一个采集箱条目认领到一个店铺 = 一条 listing。 */
export const listings = pgTable(
  "listings",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["draft", "publishing", "published", "failed"],
    })
      .notNull()
      .default("draft"),
    title: text("title").notNull(),
    descriptionHtml: text("description_html").notNull().default(""),
    images: jsonb("images").$type<string[]>().notNull().default([]),
    /** 详情图：发布时上传并追加到 descriptionHtml 末尾。 */
    descImages: jsonb("desc_images").$type<string[]>().notNull().default([]),
    options: jsonb("options").$type<ListingOption[]>().notNull().default([]),
    variants: jsonb("variants").$type<ListingVariant[]>().notNull().default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    productType: text("product_type").notNull().default(""),
    vendor: text("vendor").notNull().default(""),
    /** 已确认的平台类目（Shopify taxonomy gid）；发布时写入 productSet.category。 */
    channelCategoryId: text("channel_category_id"),
    channelCategoryName: text("channel_category_name"),
    /** 已映射的平台标准属性（发布时写入 metafields）。 */
    channelAttributes: jsonb("channel_attributes")
      .$type<ListingChannelAttribute[]>()
      .notNull()
      .default([]),
    remoteId: text("remote_id"),
    remoteUrl: text("remote_url"),
    /** channel-side status (ACTIVE/DRAFT/ARCHIVED/DELETED…), synced back */
    remoteStatus: text("remote_status").$type<RemoteStatus>(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("listings_store_source_uq").on(t.storeId, t.sourceItemId),
    index("listings_ws_status_idx").on(t.workspaceId, t.status),
  ],
);

// --- AI suggestions ------------------------------------------------------------

/** 字段级 AI 建议：认领后 AI 产线生成，用户逐条接受/拒绝，接受前不改刊登本体。 */
export const listingSuggestions = pgTable(
  "listing_suggestions",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    field: text("field", {
      enum: [
        "title",
        "descriptionHtml",
        "productType",
        "tags",
        "options",
        "category",
        "attributes",
      ],
    }).notNull(),
    /** proposed value; for `options` it's {options, variantOptionValues}. */
    value: jsonb("value").notNull(),
    status: text("status", { enum: ["pending", "accepted", "rejected"] })
      .notNull()
      .default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("listing_suggestions_listing_status_idx").on(t.listingId, t.status)],
);

/** AI 用量计量：每次 LLM 调用一行，为按 workspace 计费做准备。 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id").references(() => listings.id, {
      onDelete: "set null",
    }),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    status: text("status", { enum: ["ok", "error"] }).notNull().default("ok"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_usage_ws_created_idx").on(t.workspaceId, t.createdAt),
    index("ai_usage_listing_idx").on(t.listingId),
  ],
);

// --- category mapping --------------------------------------------------------

/** 平台类目树缓存（按需写入；Shopify taxonomy 只缓存解析过的节点）。 */
export const channelCategories = pgTable(
  "channel_categories",
  {
    id: id(),
    platform: text("platform").notNull(),
    /** 平台类目版本；Shopify taxonomy 无显式版本时固定 "taxonomy"。 */
    version: text("version").notNull(),
    categoryId: text("category_id").notNull(),
    name: text("name").notNull(),
    /** 完整路径数组（["Apparel","Tops"]）。 */
    path: jsonb("path").$type<string[]>().notNull().default([]),
    attributesSchema: jsonb("attributes_schema")
      .$type<{ attributes: ChannelAttribute[] }>()
      .notNull()
      .default({ attributes: [] }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("channel_categories_platform_version_id_uq").on(
      t.platform,
      t.version,
      t.categoryId,
    ),
  ],
);

/** 来源属性名 → 平台标准属性：确认一次，同属性名以后自动套用。 */
export const attributeMappings = pgTable(
  "attribute_mappings",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    /** 来源属性名（按原样匹配；未来可加语言/来源平台维度）。 */
    sourceName: text("source_name").notNull(),
    channelAttrId: text("channel_attr_id").notNull(),
    channelAttrName: text("channel_attr_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("attribute_mappings_ws_channel_source_uq").on(
      t.workspaceId,
      t.channel,
      t.sourceName,
    ),
  ],
);

/** 来源类目 → 平台类目：确认一次，同来源类目以后自动套用。 */
export const categoryMappings = pgTable(
  "category_mappings",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourcePlatform: text("source_platform").notNull(),
    sourceCategoryId: text("source_category_id").notNull(),
    sourceCategoryName: text("source_category_name"),
    channel: text("channel").notNull(),
    channelCategoryId: text("channel_category_id").notNull(),
    channelCategoryName: text("channel_category_name").notNull(),
    version: text("version").notNull().default(""),
    confidence: integer("confidence").notNull().default(0),
    confirmedBy: text("confirmed_by", { enum: ["user", "ai"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("category_mappings_ws_src_channel_uq").on(
      t.workspaceId,
      t.sourcePlatform,
      t.sourceCategoryId,
      t.channel,
    ),
    index("category_mappings_ws_idx").on(t.workspaceId),
  ],
);

/** 术语翻译映射（变体名/属性名/值 源词 → 目标语译文）：
 *  认领时预翻已知词；AI 建议被接受时学习新词对。 */
export const termMappings = pgTable(
  "term_mappings",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** target language, matches stores.language (e.g. "en"). */
    lang: text("lang").notNull().default(""),
    sourceText: text("source_text").notNull(),
    targetText: text("target_text").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("term_mappings_ws_lang_src_uq").on(t.workspaceId, t.lang, t.sourceText),
    index("term_mappings_ws_idx").on(t.workspaceId),
  ],
);

/** 刊登模板：可复用的店铺设置预设（妙手「产品模板」同款），套用即覆盖店铺刊登设置。 */
export const listingTemplates = pgTable(
  "listing_templates",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    payload: jsonb("payload").$type<StoreSettingsPayload>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("listing_templates_ws_name_uq").on(t.workspaceId, t.name),
    index("listing_templates_ws_idx").on(t.workspaceId),
  ],
);

// --- jobs -------------------------------------------------------------------

/** Minimal Postgres job queue (SKIP LOCKED); runs on PGlite and Postgres. */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed"],
    })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_status_run_at_idx").on(t.status, t.runAt)],
);
