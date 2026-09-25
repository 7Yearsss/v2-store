import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  ChannelIssue,
  DraftFields,
  ProductVariant,
} from "@studio/shared";

/** 冻结数据模型（docs/studio-phase0.md）。列命名即模型字段。 */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** 单租户切片：所有表暂不带 workspace 列，部署形态即单机单仓。 */
export const shops = pgTable("shops", {
  id: id(),
  platform: text("platform", { enum: ["shopee", "tiktok"] }).notNull(),
  site: text("site").notNull(),
  name: text("name").notNull(),
  authStatus: text("auth_status", { enum: ["authorized", "expired"] })
    .notNull()
    .default("authorized"),
  externalId: text("external_id"),
  createdAt: createdAt(),
});

export const products = pgTable(
  "products",
  {
    id: id(),
    source: text("source", { enum: ["manual", "import", "link"] }).notNull().default("manual"),
    sourceUrl: text("source_url"),
    title: text("title").notNull(),
    images: jsonb("images").$type<string[]>().notNull().default([]),
    variants: jsonb("variants").$type<ProductVariant[]>().notNull().default([]),
    sourceCategory: text("source_category"),
    createdAt: createdAt(),
  },
  (t) => [index("products_source_idx").on(t.source)],
);

export const listingDrafts = pgTable(
  "listing_drafts",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .unique()
      .references(() => products.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["draft", "ready"] }).notNull().default("draft"),
    fields: jsonb("fields").$type<DraftFields>().notNull(),
    aiFields: jsonb("ai_fields").$type<string[]>().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [index("draft_product_idx").on(t.productId)],
);

export const publishJobs = pgTable(
  "publish_jobs",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => listingDrafts.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "running", "partial_success", "succeeded", "failed"],
    })
      .notNull()
      .default("queued"),
    fieldsSnapshot: jsonb("fields_snapshot").$type<DraftFields>().notNull(),
    shopIds: jsonb("shop_ids").$type<string[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_created_idx").on(t.createdAt)],
);

export const publishAttempts = pgTable(
  "publish_attempts",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => publishJobs.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "running", "review", "succeeded", "failed"],
    })
      .notNull()
      .default("queued"),
    error: text("error"),
    issues: jsonb("issues").$type<ChannelIssue[]>().notNull().default([]),
    externalId: text("external_id"),
    remoteUrl: text("remote_url"),
    retryOf: uuid("retry_of"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("attempts_job_idx").on(t.jobId),
    index("attempts_status_idx").on(t.status),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actor: text("actor").notNull().default("user"),
    action: text("action").notNull(),
    entityType: text("entity_type", {
      enum: ["product", "draft", "job", "attempt", "shop"],
    }).notNull(),
    entityId: uuid("entity_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)],
);

export type ShopRow = typeof shops.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type DraftRow = typeof listingDrafts.$inferSelect;
export type JobRow = typeof publishJobs.$inferSelect;
export type AttemptRow = typeof publishAttempts.$inferSelect;
