import { eq, sql } from "drizzle-orm";
import type { DraftFields, ListingDraft, Product } from "@studio/shared";
import type { Db } from "../db/client.js";
import { listingDrafts, products, type DraftRow, type ProductRow } from "../db/schema.js";
import { notFound } from "../lib/errors.js";

export function toProduct(r: ProductRow): Product {
  return {
    id: r.id,
    source: r.source,
    sourceUrl: r.sourceUrl,
    title: r.title,
    images: r.images,
    variants: r.variants,
    sourceCategory: r.sourceCategory,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toDraft(r: DraftRow): ListingDraft {
  return {
    id: r.id,
    productId: r.productId,
    status: r.status,
    fields: r.fields,
    aiFields: [...new Set(r.aiFields)],
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** 主稿默认从货源主数据初始化；UPC/售价取第一个变体。 */
function defaultFields(p: ProductRow): DraftFields {
  const v = p.variants[0];
  return {
    images: p.images,
    title: p.title,
    bullets: [],
    description: "",
    attributes: {},
    price: v?.price ?? 0,
    compareAtPrice: null,
    category: p.sourceCategory,
    upc: v?.upc ?? null,
  };
}

export async function getProduct(db: Db, id: string): Promise<ProductRow> {
  const p = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!p) throw notFound("商品");
  return p;
}

/** 读取主稿，第一次访问时按货源初始化。 */
export async function ensureDraft(db: Db, productId: string): Promise<DraftRow> {
  const existing = await db.query.listingDrafts.findFirst({
    where: eq(listingDrafts.productId, productId),
  });
  if (existing) return existing;
  const p = await getProduct(db, productId);
  const [d] = await db
    .insert(listingDrafts)
    .values({ productId, fields: defaultFields(p) })
    .returning();
  return d;
}

export async function getDraft(db: Db, productId: string): Promise<DraftRow> {
  const d = await db.query.listingDrafts.findFirst({
    where: eq(listingDrafts.productId, productId),
  });
  if (!d) throw notFound("主稿");
  return d;
}

/** 可编辑字段是子集；未列出的键直接忽略。
 *  fields 在 SQL 层做 jsonb 顶层合并（`||`），不同字段的并发 PATCH 互不覆盖。 */
export async function patchDraft(
  db: Db,
  productId: string,
  patch: Partial<DraftFields>,
): Promise<DraftRow> {
  const d = await ensureDraft(db, productId);
  const [u] = await db
    .update(listingDrafts)
    .set({
      fields: sql`${listingDrafts.fields} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(listingDrafts.id, d.id))
    .returning();
  return u;
}
