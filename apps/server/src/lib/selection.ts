import type {
  DiscoveryFeedItem,
  DiscoverySignals,
  PricingRule,
  SelectionPlanFilters,
} from "@caiji/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import type { Db } from "../db/client.js";
import { discoveryItems, selectionPlans, stores } from "../db/schema.js";
import { applyPricing } from "./draft.js";
import { meteredChatJson } from "./ai.js";

/** priceText（"¥12.50-15"、"12.5起"）里的第一个数 → CNY 单价，取不到为 null。 */
export function parsePriceCny(priceText: string | null | undefined): number | null {
  const m = priceText?.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * 确定性打分：全部信号都来自卡片字段或店铺定价规则，缺失信号不加不减，
 * 硬门槛（requireDaiFa/require48h/minRepurchase + 价带）只在信号「确定为不满足」
 * 时判 0 —— 未知不淘汰（诚实规则）。
 */
export function scoreDiscoveryItem(
  input: { priceCny: number | null; signals: DiscoverySignals },
  filters: SelectionPlanFilters,
  pricing: PricingRule[],
): number {
  const s = input.signals;
  if (filters.requireDaiFa && s.daiFa === false) return 0;
  if (filters.require48h && s.ship48h === false) return 0;
  if (
    filters.minRepurchase != null &&
    s.repurchaseRate != null &&
    s.repurchaseRate < filters.minRepurchase
  ) {
    return 0;
  }
  // 价带是硬门槛：拿到价且越界 → 0；拿不到价不算违例。
  if (
    input.priceCny != null &&
    ((filters.priceMinCny != null && input.priceCny < filters.priceMinCny) ||
      (filters.priceMaxCny != null && input.priceCny > filters.priceMaxCny))
  ) {
    return 0;
  }

  let score = 0;
  if (s.daiFa === true) score += 20;
  if (s.ship48h === true) score += 15;
  const rr = s.repurchaseRate;
  if (rr != null) {
    if (rr >= 0.3) score += 20;
    else if (rr >= 0.2) score += 15;
    else if (rr >= 0.1) score += 10;
    else if (rr > 0) score += 5;
  }
  if (input.priceCny != null && (filters.priceMinCny != null || filters.priceMaxCny != null)) {
    score += 15; // 在价带内（上面已把越界的判 0）
  }
  if (s.sellerYears != null) {
    if (s.sellerYears >= 5) score += 5;
    else if (s.sellerYears >= 2) score += 3;
  }
  // 排名：卡片名次与榜单名次取高不叠加。
  const rankBonus = Math.max(
    s.rank != null ? (s.rank <= 10 ? 10 : s.rank <= 30 ? 6 : s.rank <= 100 ? 3 : 0) : 0,
    s.sourceRank != null ? (s.sourceRank <= 10 ? 10 : s.sourceRank <= 50 ? 5 : 0) : 0,
  );
  score += rankBonus;
  if (s.sameStyleCount != null) {
    if (s.sameStyleCount > 50) score -= 10;
    else if (s.sameStyleCount > 20) score -= 5;
  }
  // 毛利试算：用每个店铺的定价规则跑一遍，取最好的一档。
  if (input.priceCny != null && pricing.length) {
    let best = -Infinity;
    for (const rule of pricing) {
      const sell = applyPricing(input.priceCny, rule);
      if (!sell || sell <= 0) continue;
      const cost = (input.priceCny + (rule.extraCostCny ?? 0)) * rule.exchangeRate;
      best = Math.max(best, (sell - cost) / sell);
    }
    if (best >= 0.5) score += 20;
    else if (best >= 0.3) score += 15;
    else if (best >= 0.15) score += 8;
  }
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

/** 到期判定：未跑过即到期；daily 计划距上次 feed ≥24h 到期。 */
export function planIsDue(plan: { lastRunAt: Date | string | null; schedule: string }): boolean {
  // manual 计划只响应 run-now，不走 alarm 周期
  if (plan.schedule !== "daily") return false;
  if (plan.lastRunAt == null) return true;
  const at = new Date(plan.lastRunAt).getTime();
  return Number.isFinite(at) && Date.now() - at >= 24 * 3600 * 1000;
}

/** 计划的抓取 URL 清单（插件 alarm 拿着去抓列表页）。 */
export function planUrls(plan: {
  source: string;
  filters: SelectionPlanFilters;
}): string[] {
  const keywords = (plan.filters.keywords ?? [])
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 5);
  const urls: string[] = [];
  for (const kw of keywords) {
    const p = new URLSearchParams({ keywords: kw });
    if (plan.filters.priceMinCny != null) p.set("beginPrice", String(plan.filters.priceMinCny));
    if (plan.filters.priceMaxCny != null) p.set("endPrice", String(plan.filters.priceMaxCny));
    if (plan.source === "1688_rank") p.set("sortType", "va_rmdarkgmv30down"); // 销量榜
    urls.push(`https://s.1688.com/selloffer/offer_search.htm?${p.toString()}`);
  }
  return urls;
}

/** feed upsert：幂等键 (workspace, plan, source_item_id)；同名 offer 在别的计划里独立成行。 */
export async function upsertDiscoveryItems(
  db: Db,
  workspaceId: string,
  planId: string | null,
  items: DiscoveryFeedItem[],
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  for (const item of items) {
    const sourceItemId = String(item.sourceItemId ?? "").trim();
    if (!sourceItemId) continue;
    const where =
      planId == null
        ? and(
            eq(discoveryItems.workspaceId, workspaceId),
            sql`${discoveryItems.planId} is null`,
            eq(discoveryItems.sourceItemId, sourceItemId),
          )
        : and(
            eq(discoveryItems.workspaceId, workspaceId),
            eq(discoveryItems.planId, planId),
            eq(discoveryItems.sourceItemId, sourceItemId),
          );
    const [existing] = await db.select().from(discoveryItems).where(where).limit(1);
    if (!existing) {
      await db.insert(discoveryItems).values({
        workspaceId,
        planId,
        sourceItemId,
        title: item.title?.trim() || null,
        priceText: item.priceText?.trim() || null,
        thumb: item.thumb?.trim() || null,
        signals: item.signals ?? {},
      });
      inserted++;
      continue;
    }
    // 更新只补拿得到的字段；signals 键级合并，拿到的覆盖、没拿到的保留。
    const mergedSignals: DiscoverySignals = { ...existing.signals };
    for (const [k, v] of Object.entries(item.signals ?? {})) {
      if (v !== undefined) (mergedSignals as Record<string, unknown>)[k] = v;
    }
    await db
      .update(discoveryItems)
      .set({
        title: item.title?.trim() || existing.title,
        priceText: item.priceText?.trim() || existing.priceText,
        thumb: item.thumb?.trim() || existing.thumb,
        signals: mergedSignals,
      })
      .where(eq(discoveryItems.id, existing.id));
    updated++;
  }
  return { inserted, updated };
}

/** 详情页采集入库后回填候选池：同 offerId 的 new 条目 → collected + 指向入箱行。 */
export async function backfillDiscovery(
  db: Db,
  workspaceId: string,
  offerId: string | undefined,
  sourceItemDbId: string,
): Promise<number> {
  if (!offerId) return 0;
  const rows = await db
    .update(discoveryItems)
    .set({ status: "collected", sourceItemDbId })
    .where(
      and(
        eq(discoveryItems.workspaceId, workspaceId),
        eq(discoveryItems.sourceItemId, offerId),
        eq(discoveryItems.status, "new"),
      ),
    )
    .returning({ id: discoveryItems.id });
  return rows.length;
}

/** 给候选池打分的确定性部分 + top-20 LLM 评语；被 jobs 处理器调用。 */
export async function scorePlanItems(
  deps: Deps,
  workspaceId: string,
  planId: string | null,
): Promise<{ scored: number; noted: number; expired: number }> {
  const db = deps.db;
  const planCond =
    planId == null ? sql`${discoveryItems.planId} is null` : eq(discoveryItems.planId, planId);
  const items = await db
    .select()
    .from(discoveryItems)
    .where(and(eq(discoveryItems.workspaceId, workspaceId), planCond, eq(discoveryItems.status, "new")));
  if (!items.length) return { scored: 0, noted: 0, expired: 0 };

  const plan =
    planId == null
      ? null
      : ((await db.select().from(selectionPlans).where(eq(selectionPlans.id, planId)).limit(1))[0] ??
        null);
  const filters = plan?.filters ?? {};

  const storeRows = await db
    .select({ pricing: stores.pricing })
    .from(stores)
    .where(and(eq(stores.workspaceId, workspaceId), eq(stores.status, "active")));
  const pricing = storeRows.map((r) => r.pricing);

  const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  let scored = 0;
  let expired = 0;
  const rows: Array<{ id: string; score: number }> = [];
  for (const item of items) {
    if (new Date(item.createdAt) < cutoff) {
      await db
        .update(discoveryItems)
        .set({ status: "expired" })
        .where(eq(discoveryItems.id, item.id));
      expired++;
      continue;
    }
    const score = scoreDiscoveryItem(
      { priceCny: parsePriceCny(item.priceText), signals: item.signals },
      filters,
      pricing,
    );
    rows.push({ id: item.id, score });
    await db.update(discoveryItems).set({ score }).where(eq(discoveryItems.id, item.id));
    scored++;
  }

  // LLM 只对 top-20 写一句话理由；没有 AI 配置就跳过，不报错。
  let noted = 0;
  const top = rows
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .filter((r) => r.score > 0);
  if (deps.config.ai && top.length) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const brief = top
      .map((r) => {
        const it = byId.get(r.id)!;
        return {
          id: r.id,
          title: it.title,
          price: it.priceText,
          score: r.score,
          signals: it.signals,
        };
      })
      .filter((b) => b.title);
    try {
      const { data } = await meteredChatJson(
        deps,
        { workspaceId },
        {
          system:
            "你是跨境电商选品助手。根据候选货源的确定性信号（一件代发/48h发货/回头率/排名/试算毛利分），" +
            "为每个候选写一句不超过 40 字的中文理由，指出最值得采集的点或主要风险。" +
            "只引用给出的信号，不要编造未提供的指标。输出 JSON：{\"notes\":[{\"id\":\"\",\"note\":\"\"}]}。",
          user: JSON.stringify({ items: brief }),
          timeoutMs: 60_000,
        },
      );
      const notes =
        (data as { notes?: Array<{ id?: string; note?: string }> } | null)?.notes ?? [];
      for (const n of notes) {
        const id = String(n.id ?? "");
        const note = String(n.note ?? "").trim().slice(0, 200);
        if (!id || !note || !byId.has(id)) continue;
        await db
          .update(discoveryItems)
          .set({ aiNote: note })
          .where(and(eq(discoveryItems.id, id), eq(discoveryItems.workspaceId, workspaceId)));
        noted++;
      }
    } catch {
      // AI 不可用不是致命错误：分数已写，评语留空。
    }
  }
  return { scored, noted, expired };
}
