import { and, eq } from "drizzle-orm";
import type {
  CategoryCandidate,
  CategorySuggestionValue,
  SourcePlatform,
} from "@caiji/shared";
import { adapterFor } from "../channels/index.js";
import type { Deps } from "../context.js";
import { listingSuggestions, listings, sourceItems, stores } from "../db/schema.js";
import { PermanentJobError } from "../jobs/queue.js";
import { meteredChatJson } from "../lib/ai.js";
import {
  cacheCategoryNodes,
  resolveCategoryMapping,
  TAXONOMY_VERSION,
} from "../lib/category.js";

/**
 * 类目建议产线：认领后遇到未见过的来源类目时跑一次。
 * AI 出搜索词 → 平台类目搜索 → AI 排序取 Top-3 → 写 field=category 建议。
 * 用户确认某个候选后写入 category_mappings，同来源类目以后自动套用。
 */

const SEARCH_TERMS_PROMPT = `你是跨境电商类目映射助手。根据货源(1688)商品的标题与来源类目名，给出 1-3 个用于在目标平台类目库中搜索的英文关键词（宽到窄，不要品牌词）。只输出 JSON: {"terms": ["..."]}`;

const RANK_PROMPT = `你是跨境电商类目映射助手。给定货源(1688)商品信息与目标平台类目候选列表，挑出最合适的最多 3 个叶子类目并按相关度排序，给出 0-100 的 confidence。只输出 JSON: {"picks": [{"id": "...", "confidence": 80}]}`;

interface TermsOut {
  terms?: string[];
}
interface RankOut {
  picks?: Array<{ id?: string; confidence?: number }>;
}

export async function runCategorySuggest(deps: Deps, listingId: string) {
  const [row] = await deps.db
    .select({ listing: listings, store: stores, item: sourceItems })
    .from(listings)
    .innerJoin(stores, eq(stores.id, listings.storeId))
    .innerJoin(sourceItems, eq(sourceItems.id, listings.sourceItemId))
    .where(eq(listings.id, listingId));
  if (!row) throw new PermanentJobError("刊登记录已删除");
  const { listing, store, item } = row;
  if (store.aiEnhance === "off" || !deps.config.ai) return;
  if (listing.channelCategoryId) return;
  if (!item.sourceCategoryId) return;
  const mapped = await resolveCategoryMapping(
    deps.db,
    listing.workspaceId,
    item.sourcePlatform as SourcePlatform,
    item.sourceCategoryId,
    store.platform,
  );
  if (mapped) return;

  const adapter = adapterFor(store.platform);
  if (!adapter.searchCategories) return;

  const meta = { workspaceId: listing.workspaceId, listingId };
  const termsRes = await meteredChatJson(deps, meta, {
    system: SEARCH_TERMS_PROMPT,
    user: [
      `source title: ${listing.title}`,
      item.sourceCategoryName ? `source category: ${item.sourceCategoryName}` : "",
      `Respond with JSON: {"terms": ["...", "..."]}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const terms = ((termsRes.data as TermsOut).terms ?? [])
    .filter((t): t is string => typeof t === "string" && !!t.trim())
    .map((t) => t.trim())
    .slice(0, 3);

  const byId = new Map<string, CategoryCandidate>();
  for (const term of terms) {
    const found = await adapter.searchCategories(deps, store, term);
    for (const c of found) if (!byId.has(c.id)) byId.set(c.id, c);
    if (byId.size >= 15) break;
  }
  const candidates = [...byId.values()].slice(0, 15);
  if (!candidates.length) return;
  await cacheCategoryNodes(deps.db, store.platform, TAXONOMY_VERSION, candidates);

  const rankRes = await meteredChatJson(deps, meta, {
    system: RANK_PROMPT,
    user: [
      `source title: ${listing.title}`,
      item.sourceCategoryName ? `source category: ${item.sourceCategoryName}` : "",
      `candidates:`,
      ...candidates.map((c) => `- ${c.id} :: ${c.fullName || c.name}`),
      `Respond with JSON: {"picks": [{"id": "...", "confidence": 80}]}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const picks = (rankRes.data as RankOut).picks ?? [];
  const rank = new Map(
    picks
      .filter((p): p is { id: string; confidence?: number } => typeof p?.id === "string")
      .map((p) => [p.id, p.confidence ?? 0]),
  );
  const top = candidates
    .filter((c) => rank.has(c.id))
    .sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0))
    .slice(0, 3);
  const final = top.length ? top : candidates.slice(0, 3);

  const value: CategorySuggestionValue = {
    sourceCategoryId: item.sourceCategoryId,
    sourceCategoryName: item.sourceCategoryName,
    candidates: final,
  };
  await deps.db.transaction(async (tx) => {
    await tx
      .delete(listingSuggestions)
      .where(
        and(
          eq(listingSuggestions.listingId, listingId),
          eq(listingSuggestions.status, "pending"),
          eq(listingSuggestions.field, "category"),
        ),
      );
    await tx.insert(listingSuggestions).values({
      workspaceId: listing.workspaceId,
      listingId,
      field: "category",
      value,
    });
  });
}
