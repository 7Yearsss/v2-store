import type {
  AttributesSuggestionValue,
  CategorySuggestionValue,
  OptionsSuggestionValue,
} from "@caiji/shared";
import type { ListingRow } from "../channels/types.js";
import type { Db } from "../db/client.js";
import type { listingSuggestions } from "../db/schema.js";
import { upsertAttrMappings } from "./attributes.js";
import { TAXONOMY_VERSION, upsertCategoryMapping } from "./category.js";
import { HttpError } from "./errors.js";
import { upsertTermPairs } from "./terms.js";

export type SuggestionRow = typeof listingSuggestions.$inferSelect;

/** Write an accepted suggestion into the listing row (pure field patch, no side effects). */
export function applySuggestion(listing: ListingRow, s: SuggestionRow): Partial<ListingRow> {
  switch (s.field) {
    case "title":
      return { title: String(s.value).slice(0, 255) };
    case "descriptionHtml":
      return { descriptionHtml: String(s.value).slice(0, 200_000) };
    case "productType":
      return { productType: String(s.value).slice(0, 255) };
    case "tags":
      return { tags: (s.value as string[]).slice(0, 250) };
    case "options": {
      const v = s.value as OptionsSuggestionValue;
      const variants = listing.variants.map((vr, i) => ({
        ...vr,
        optionValues: v.variantOptionValues[i] ?? vr.optionValues,
      }));
      return { options: v.options, variants };
    }
    case "attributes": {
      const v = s.value as AttributesSuggestionValue;
      return {
        channelAttributes: v.attributes.map((a) => ({
          attrId: a.attrId,
          name: a.attrName,
          value: a.value,
        })),
      };
    }
    default:
      return {};
  }
}

export interface AcceptContext {
  workspaceId: string;
  /** 刊登所在店铺平台（类目/属性映射的 channel 维）。 */
  storePlatform: string;
  storeLanguage: string;
  /** 来源平台（类目映射的 sourcePlatform 维）。 */
  sourcePlatform: string;
  /** user = 人工确认；ai = 链路 autoAccept 自动确认。 */
  confirmedBy: "user" | "ai";
  /** 类目建议接受的候选 id；缺省取 AI 排第一的。 */
  choice?: string;
}

/**
 * accept 一条建议：返回刊登字段补丁，并执行学习钩子
 * （category→类目映射、options→术语对、attributes→属性映射）。
 * decide 端点与 pipeline.autoAccept 共用同一套「应用+学习」。必须在事务里调用。
 */
export async function acceptSuggestion(
  tx: Db,
  listing: ListingRow,
  s: SuggestionRow,
  ctx: AcceptContext,
): Promise<Partial<ListingRow>> {
  if (s.field === "category") {
    const v = s.value as CategorySuggestionValue;
    const cand = v.candidates.find((cd) => cd.id === ctx.choice) ?? v.candidates[0];
    if (!cand) throw new HttpError(400, "类目建议没有可选候选");
    // 确认即记住：同来源类目以后自动套用
    await upsertCategoryMapping(tx, {
      workspaceId: ctx.workspaceId,
      sourcePlatform: ctx.sourcePlatform,
      sourceCategoryId: v.sourceCategoryId ?? "",
      sourceCategoryName: v.sourceCategoryName,
      channel: ctx.storePlatform,
      candidate: cand,
      confidence: 100,
      confirmedBy: ctx.confirmedBy,
      version: TAXONOMY_VERSION,
    });
    return {
      channelCategoryId: cand.id,
      channelCategoryName: cand.fullName || cand.name,
    };
  }

  const patch = applySuggestion(listing, s);
  if (s.field === "options") {
    const v = s.value as OptionsSuggestionValue;
    // 接受即学习：以建议生成时的选项快照为准（用户可能已改过草稿），按位成对存术语映射
    const pairs: Array<[string, string]> = [];
    (v.sourceOptions ?? listing.options).forEach((o, i) => {
      pairs.push([o.name, v.options[i]?.name ?? o.name]);
      o.values.forEach((sv, j) => {
        pairs.push([sv, v.options[i]?.values[j] ?? sv]);
      });
    });
    await upsertTermPairs(tx, ctx.workspaceId, ctx.storeLanguage, pairs);
  }
  // 接受属性提案即记住 源属性名→平台属性 映射
  if (s.field === "attributes") {
    const v = s.value as AttributesSuggestionValue;
    await upsertAttrMappings(
      tx,
      ctx.workspaceId,
      ctx.storePlatform,
      v.attributes.map((a) => ({
        sourceName: a.sourceName,
        attrId: a.attrId,
        attrName: a.attrName,
      })),
    );
  }
  return patch;
}
