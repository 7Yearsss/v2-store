import type {
  ListingOption,
  ListingVariant,
  OfferSku,
  PricingRule,
  RemoteStatus,
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
    attributes: jsonb("attributes")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    sellerName: text("seller_name"),
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
    options: jsonb("options").$type<ListingOption[]>().notNull().default([]),
    variants: jsonb("variants").$type<ListingVariant[]>().notNull().default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    productType: text("product_type").notNull().default(""),
    vendor: text("vendor").notNull().default(""),
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
