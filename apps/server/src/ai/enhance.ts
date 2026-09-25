import { and, eq } from "drizzle-orm";
import type { ListingOption, OptionsSuggestionValue } from "@caiji/shared";
import type { Deps } from "../context.js";
import { listingSuggestions, listings, sourceItems, stores } from "../db/schema.js";
import { PermanentJobError } from "../jobs/queue.js";
import { chatJson } from "../lib/ai.js";

/**
 * AI 产线：认领后跑一次，产出字段级建议（listing_suggestions）。
 * 只写建议行，不改刊登本体 —— 接受之前刊登保持原样。
 */

const LANG_NAMES: Record<string, string> = {
  en: "English",
  "en-US": "English (US)",
  "en-GB": "English (UK)",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  ja: "Japanese",
  ko: "Korean",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ms: "Malay",
  ar: "Arabic",
  ru: "Russian",
};

interface EnhanceOutput {
  title?: string;
  descriptionHtml?: string;
  productType?: string;
  tags?: string[];
  options?: Array<{ name: string; values: string[] }>;
}

const SYSTEM_PROMPT = `你是跨境电商刊登助手。把货源(1688)商品信息加工成面向目标市场的高质量刊登内容。

规则：
- 输出语言：target language 指定的语言。
- 标题：SEO 友好、突出卖点，不超过 180 字符；去掉供应商话术（如"厂家直销""一件代发""【定制联系客服】"等）、去掉货源平台词汇（1688/阿里巴巴）。
- 描述：简洁 HTML（<p>/<ul>/<li>/<strong> 即可），突出卖点与规格参数，不出现供应商联系方式、中文话术、货源平台名。
- productType：用目标语言给出一个简短类目词（如 "Phone Stand"）。
- tags：5–12 个目标语言关键词标签。
- options：把变体选项名与每个选项值翻译成目标语言，保持数组结构与数量与输入完全一致（option 顺序、每个 option 的 values 顺序都不变）。
- 只输出 JSON。`;

function buildUserPrompt(input: {
  title: string;
  attributes: Record<string, string>;
  priceText: string | null;
  options: ListingOption[];
  targetLang: string;
}) {
  const lang = LANG_NAMES[input.targetLang] ?? input.targetLang;
  return [
    `target language: ${lang} (${input.targetLang})`,
    `source title: ${input.title}`,
    input.priceText ? `source price: ${input.priceText}` : "",
    `attributes:`,
    ...Object.entries(input.attributes).map(([k, v]) => `- ${k}: ${v}`),
    input.options.length
      ? `options to translate (keep structure/order identical): ${JSON.stringify(input.options)}`
      : "no options",
    ``,
    `Respond with JSON: {"title": "...", "descriptionHtml": "...", "productType": "...", "tags": [...], "options": [{"name": "...", "values": [...]}]}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Map each variant's optionValues through the translated options (index-aligned). */
function translatedVariantValues(
  options: ListingOption[],
  translated: Array<{ name: string; values: string[] }>,
  variants: Array<{ optionValues: string[] }>,
): string[][] {
  return variants.map((v) =>
    v.optionValues.map((orig, i) => {
      const origValues = options[i]?.values ?? [];
      const idx = origValues.indexOf(orig);
      const newValues = translated[i]?.values ?? [];
      return idx >= 0 && idx < newValues.length ? newValues[idx]! : orig;
    }),
  );
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runAiEnhance(deps: Deps, listingId: string) {
  const [row] = await deps.db
    .select({ listing: listings, store: stores, item: sourceItems })
    .from(listings)
    .innerJoin(stores, eq(stores.id, listings.storeId))
    .innerJoin(sourceItems, eq(sourceItems.id, listings.sourceItemId))
    .where(eq(listings.id, listingId));
  if (!row) throw new PermanentJobError("刊登记录已删除");
  const { listing, store, item } = row;
  if (store.aiEnhance === "off" || !deps.config.ai) return;

  const out = (await chatJson(deps, {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({
      title: listing.title,
      attributes: item.attributes,
      priceText: item.priceText,
      options: listing.options,
      targetLang: store.language,
    }),
  })) as EnhanceOutput;

  const proposals: Array<{ field: string; value: unknown }> = [];
  if (typeof out.title === "string" && out.title.trim() && out.title.trim() !== listing.title) {
    proposals.push({ field: "title", value: out.title.trim().slice(0, 255) });
  }
  if (
    typeof out.descriptionHtml === "string" &&
    out.descriptionHtml.trim() &&
    out.descriptionHtml !== listing.descriptionHtml
  ) {
    proposals.push({ field: "descriptionHtml", value: out.descriptionHtml.slice(0, 200_000) });
  }
  if (
    typeof out.productType === "string" &&
    out.productType.trim() &&
    out.productType.trim() !== listing.productType
  ) {
    proposals.push({ field: "productType", value: out.productType.trim().slice(0, 255) });
  }
  if (Array.isArray(out.tags)) {
    const tags = out.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (tags.length && !sameJson(tags, listing.tags)) proposals.push({ field: "tags", value: tags });
  }
  if (Array.isArray(out.options) && out.options.length === listing.options.length) {
    const translated: ListingOption[] = out.options.map((o, i) => ({
      name: typeof o?.name === "string" && o.name.trim() ? o.name.trim() : listing.options[i]!.name,
      values: Array.isArray(o?.values)
        ? o.values.map((v, j) =>
            typeof v === "string" && v.trim() ? v.trim() : listing.options[i]!.values[j] ?? "",
          )
        : listing.options[i]!.values,
    }));
    if (!sameJson(translated, listing.options)) {
      const value: OptionsSuggestionValue = {
        options: translated,
        variantOptionValues: translatedVariantValues(listing.options, translated, listing.variants),
      };
      proposals.push({ field: "options", value });
    }
  }

  await deps.db.transaction(async (tx) => {
    // fresh run supersedes any older pending proposals for this listing
    await tx
      .delete(listingSuggestions)
      .where(
        and(eq(listingSuggestions.listingId, listingId), eq(listingSuggestions.status, "pending")),
      );
    if (proposals.length) {
      await tx.insert(listingSuggestions).values(
        proposals.map((p) => ({
          workspaceId: listing.workspaceId,
          listingId,
          field: p.field as (typeof listingSuggestions.field.enumValues)[number],
          value: p.value,
        })),
      );
    }
  });
}
