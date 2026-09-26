import { and, eq, inArray } from "drizzle-orm";
import type { SuggestionField } from "@caiji/shared";
import type { ListingRow, StoreRow } from "../../channels/types.js";
import type { Deps } from "../../context.js";
import type { Db } from "../../db/client.js";
import { listingSuggestions, listings, sourceItems, stores } from "../../db/schema.js";
import { PermanentJobError } from "../../jobs/queue.js";

export type SourceItemRow = typeof sourceItems.$inferSelect;

export interface StageContext {
  deps: Deps;
  listing: ListingRow;
  store: StoreRow;
  item: SourceItemRow;
}

export interface StageProposal {
  field: SuggestionField;
  value: unknown;
}

/**
 * AI 产线的一个 stage。幂等粒度 (listing_id, field ∈ fields, stage)：
 * 重跑只覆盖自己产出的 pending 建议，不动其他 stage 的、也不动已审核的。
 */
export interface Stage {
  /** 稳定 key，写进 listing_suggestions.stage；rules.pipeline.disabledStages 按它关。 */
  key: string;
  /** llm = 模型产出；deterministic = 规则产出。 */
  kind: "llm" | "deterministic";
  /** 本 stage 拥有的建议字段。 */
  fields: SuggestionField[];
  run(ctx: StageContext): Promise<void>;
}

/** 加载 stage 上下文：刊登 + 店铺 + 货源条目。刊登不存在 = 永久失败。 */
export async function loadStageRow(
  deps: Deps,
  listingId: string,
): Promise<{ listing: ListingRow; store: StoreRow; item: SourceItemRow }> {
  const [row] = await deps.db
    .select({ listing: listings, store: stores, item: sourceItems })
    .from(listings)
    .innerJoin(stores, eq(stores.id, listings.storeId))
    .innerJoin(sourceItems, eq(sourceItems.id, listings.sourceItemId))
    .where(eq(listings.id, listingId));
  if (!row) throw new PermanentJobError("刊登记录已删除");
  return row;
}

/** 删本 stage 字段范围内的 pending 建议并重插；stage='ai' 的旧行视为对应 stage 的产出。 */
export async function replaceStageSuggestions(
  db: Db,
  listing: ListingRow,
  stage: Stage,
  proposals: StageProposal[],
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(listingSuggestions)
      .where(
        and(
          eq(listingSuggestions.listingId, listing.id),
          eq(listingSuggestions.status, "pending"),
          inArray(listingSuggestions.field, stage.fields),
          inArray(listingSuggestions.stage, [stage.key, "ai"]),
        ),
      );
    if (proposals.length) {
      await tx.insert(listingSuggestions).values(
        proposals.map((p) => ({
          workspaceId: listing.workspaceId,
          listingId: listing.id,
          field: p.field,
          stage: stage.key,
          value: p.value,
        })),
      );
    }
  });
}
