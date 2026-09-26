import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { SourceChange, SourceChangeAppliedAction } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import type { Db } from "../db/client.js";
import { listings, sourceChanges, sourceItems, stores } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { applyPricing } from "../lib/draft.js";
import { pushQuantity } from "../lib/sourceMonitor.js";
import {
  DELIST_LISTING,
  PUSH_PRICE,
  PUSH_STOCK,
} from "../jobs/handlers.js";
import { enqueue } from "../jobs/queue.js";
import { requireAuth } from "./auth.js";

type ChangeRow = typeof sourceChanges.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type StoreRulesRow = (typeof stores.$inferSelect)["rules"];
type PricingRow = (typeof stores.$inferSelect)["pricing"];

function toDto(r: ChangeRow): SourceChange {
  return {
    id: r.id,
    sourceItemId: r.sourceItemId,
    changeType: r.changeType,
    skuId: r.skuId,
    oldValue: r.oldValue,
    newValue: r.newValue,
    detectedAt: r.detectedAt.toISOString(),
    appliedAt: r.appliedAt?.toISOString() ?? null,
    appliedAction: r.appliedAction,
  };
}

/** 变更应用到一条刊登（人工「应用」是显式指令，不再复核监控开关）；
 *  返回落到 applied_action 的 action 名。 */
async function applyChangeToListing(
  db: Db,
  workspaceId: string,
  change: ChangeRow,
  listing: ListingRow,
  storeRules: StoreRulesRow,
  pricing: PricingRow,
): Promise<SourceChangeAppliedAction> {
  const published = listing.status === "published" && !!listing.remoteId;
  const patch: Partial<ListingRow> = {};
  let action = "applied";
  const nv = change.newValue as Record<string, unknown> | string | null;
  const nvo = nv && typeof nv === "object" ? nv : null;

  switch (change.changeType) {
    case "price": {
      const priceCny = typeof nvo?.priceCny === "number" ? nvo.priceCny : null;
      const variants = listing.variants.map((v) =>
        change.skuId === null || v.sourceSkuId === change.skuId
          ? {
              ...v,
              costCny: priceCny ?? v.costCny,
              price: priceCny != null ? applyPricing(priceCny, pricing) : v.price,
            }
          : v,
      );
      patch.variants = variants;
      if (published) {
        await enqueue(db, PUSH_PRICE, { listingId: listing.id, manual: true }, { workspaceId });
        action = "price_push_queued";
      } else {
        action = "price_recalculated";
      }
      break;
    }
    case "stock": {
      const inv = storeRules?.inventory;
      const variants = listing.variants.map((v) => {
        if (change.skuId !== null && v.sourceSkuId !== change.skuId) return v;
        const src = typeof nvo?.stock === "number" ? nvo.stock : 0;
        return { ...v, stock: pushQuantity(src, inv) };
      });
      patch.variants = variants;
      if (published) {
        await enqueue(db, PUSH_STOCK, { listingId: listing.id, manual: true }, { workspaceId });
        action = "stock_push_queued";
      } else {
        action = "stock_updated";
      }
      break;
    }
    case "title": {
      const title = typeof nv === "string" ? nv : null;
      if (title) {
        patch.title = title.slice(0, 255);
        action = published ? "title_applied_republish_needed" : "title_applied";
      } else {
        action = "skipped";
      }
      break;
    }
    case "images": {
      const imgs = nvo?.images;
      if (Array.isArray(imgs) && imgs.length) {
        patch.images = imgs.slice(0, 250);
        action = published ? "images_applied_republish_needed" : "images_applied";
      } else {
        action = "skipped";
      }
      break;
    }
    case "attributes":
      // 属性走平台映射/AI 产线，不直接改刊登字段
      action = "manual_review";
      break;
    case "delisted": {
      const oosAction = storeRules?.inventory?.oosAction ?? "notify";
      if (oosAction === "zero") {
        patch.variants = listing.variants.map((v) => ({ ...v, stock: 0 }));
        if (published && storeRules?.trackStock) {
          await enqueue(
            db,
            PUSH_STOCK,
            { listingId: listing.id, force: true },
            { workspaceId },
          );
          action = "oos_zero_queued";
        } else {
          action = "oos_zero";
        }
      } else if (oosAction === "unpublish") {
        if (published) {
          await enqueue(db, DELIST_LISTING, { listingId: listing.id }, { workspaceId });
          action = "oos_unpublish_queued";
        } else {
          action = "oos_unpublish_draft";
        }
      } else {
        action = "oos_notify";
      }
      break;
    }
  }

  if (Object.keys(patch).length) {
    await db
      .update(listings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(listings.id, listing.id));
  }
  return { listingId: listing.id, action };
}

export function sourceChangeRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  const listQuery = z.object({
    sourceItemId: z.string().uuid().optional(),
    changeType: z
      .enum(["price", "stock", "title", "images", "attributes", "delisted"])
      .optional(),
    /** 默认全部；true=只看未消费。coerce.boolean 会把 "false" 当 true，不能用它。 */
    pending: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  });

  r.get("/", zValidator("query", listQuery), async (c) => {
    const { db } = c.var.deps;
    const workspaceId = c.var.auth.workspaceId;
    const q = c.req.valid("query");
    const where = and(
      eq(sourceChanges.workspaceId, workspaceId),
      q.sourceItemId ? eq(sourceChanges.sourceItemId, q.sourceItemId) : undefined,
      q.changeType ? eq(sourceChanges.changeType, q.changeType) : undefined,
      q.pending ? isNull(sourceChanges.appliedAt) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(sourceChanges)
        .where(where)
        .orderBy(desc(sourceChanges.detectedAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      db.select({ n: count() }).from(sourceChanges).where(where),
    ]);
    return c.json({ items: rows.map(toDto), total: total?.n ?? 0 });
  });

  /** 消费变更：apply=按类型落到刊登（并视情形推远端）；ignore=仅落账。 */
  r.post(
    "/decide",
    zValidator(
      "json",
      z.object({
        ids: z.array(z.string().uuid()).min(1).max(200),
        action: z.enum(["apply", "ignore"]),
      }),
    ),
    async (c) => {
      const { db } = c.var.deps;
      const workspaceId = c.var.auth.workspaceId;
      const { ids, action } = c.req.valid("json");
      const now = new Date();
      const rows = await db
        .select()
        .from(sourceChanges)
        .where(
          and(
            eq(sourceChanges.workspaceId, workspaceId),
            inArray(sourceChanges.id, ids),
            isNull(sourceChanges.appliedAt),
          ),
        );
      let applied = 0;
      let ignored = 0;
      const touchedItems = new Set<string>();
      for (const change of rows) {
        if (action === "ignore") {
          await db
            .update(sourceChanges)
            .set({ appliedAt: now, appliedAction: [{ action: "ignored" }] })
            .where(eq(sourceChanges.id, change.id));
          ignored++;
          continue;
        }
        const linked = await db
          .select({ listing: listings, storeRules: stores.rules, pricing: stores.pricing })
          .from(listings)
          .innerJoin(stores, eq(stores.id, listings.storeId))
          .where(
            and(
              eq(listings.workspaceId, workspaceId),
              eq(listings.sourceItemId, change.sourceItemId),
            ),
          );
        const acts: SourceChangeAppliedAction[] = [];
        for (const { listing, storeRules, pricing } of linked) {
          acts.push(
            await applyChangeToListing(
              db,
              workspaceId,
              change,
              listing,
              storeRules,
              pricing,
            ),
          );
        }
        await db
          .update(sourceChanges)
          .set({
            appliedAt: now,
            appliedAction: acts.length ? acts : [{ action: "no_listings" }],
          })
          .where(eq(sourceChanges.id, change.id));
        touchedItems.add(change.sourceItemId);
        applied++;
      }
      for (const sid of touchedItems) {
        await audit(db, workspaceId, {
          actor: `user:${c.var.auth.userId}`,
          action: "source.change.apply",
          entityType: "source_item",
          entityId: sid,
        });
      }
      return c.json({ applied, ignored, skipped: ids.length - applied - ignored });
    },
  );

  return r;
}
