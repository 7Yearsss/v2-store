import type {
  AttributesSuggestionValue,
  ChannelAttribute,
  ChannelAttributeProposal,
  ListingOption,
  OptionsSuggestionValue,
} from "@caiji/shared";
import { meteredChatJson } from "../../lib/ai.js";
import { cachedCategoryAttributes } from "../../lib/attributes.js";
import { replaceStageSuggestions, type Stage, type StageProposal } from "./types.js";

/**
 * enhance stage：认领后的主 AI 产线，产出字段级建议（listing_suggestions）。
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
  channelAttributes?: Array<{
    sourceName?: string;
    sourceValue?: string;
    attrId?: string;
    attrName?: string;
    value?: string;
  }>;
}

const SYSTEM_PROMPT = `你是跨境电商刊登助手。把货源(1688)商品信息加工成面向目标市场的高质量刊登内容。

规则：
- 输出语言：target language 指定的语言。
- 标题：SEO 友好、突出卖点，不超过 180 字符；去掉供应商话术（如"厂家直销""一件代发""【定制联系客服】"等）、去掉货源平台词汇（1688/阿里巴巴）。
- 描述：简洁 HTML（<p>/<ul>/<li>/<strong> 即可），突出卖点与规格参数，不出现供应商联系方式、中文话术、货源平台名。
- productType：用目标语言给出一个简短类目词（如 "Phone Stand"）。
- tags：5–12 个目标语言关键词标签。
- options：把变体选项名与每个选项值翻译成目标语言，保持数组结构与数量与输入完全一致（option 顺序、每个 option 的 values 顺序都不变）。
- channelAttributes：当给了平台类目的标准属性清单时，把来源属性映射到语义匹配的标准属性上；取值翻成目标语言，choice 属性必须严格取清单里的值；匹配不上的来源属性跳过；最多再加 3 个有把握的新属性（sourceName 留空）。没有清单时不输出这个字段。
- 只输出 JSON。`;

function buildUserPrompt(input: {
  title: string;
  attributes: Record<string, string>;
  priceText: string | null;
  options: ListingOption[];
  targetLang: string;
  channelAttrs: ChannelAttribute[];
}) {
  const lang = LANG_NAMES[input.targetLang] ?? input.targetLang;
  const attrLines = input.channelAttrs.map((a) => {
    const vals =
      a.kind === "choice" && a.values?.length
        ? ` (choice: ${a.values.slice(0, 30).map((v) => v.name).join(", ")}${a.values.length > 30 ? ", ..." : ""})`
        : a.kind === "measurement"
          ? " (number+unit)"
          : "";
    return `- ${a.name} [${a.id}]${vals}`;
  });
  return [
    `target language: ${lang} (${input.targetLang})`,
    `source title: ${input.title}`,
    input.priceText ? `source price: ${input.priceText}` : "",
    `attributes:`,
    ...Object.entries(input.attributes).map(([k, v]) => `- ${k}: ${v}`),
    input.options.length
      ? `options to translate (keep structure/order identical): ${JSON.stringify(input.options)}`
      : "no options",
    ...(attrLines.length
      ? [
          ``,
          `target platform category standard attributes (attrId in [brackets]):`,
          ...attrLines,
          ``,
          `For "channelAttributes" in the response map source attributes onto these.`,
        ]
      : []),
    ``,
    `Respond with JSON: {"title": "...", "descriptionHtml": "...", "productType": "...", "tags": [...], "options": [{"name": "...", "values": [...]}], "channelAttributes": [{"sourceName": "...", "sourceValue": "...", "attrId": "...", "attrName": "...", "value": "..."}]}`,
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

export const enhanceStage: Stage = {
  key: "enhance",
  kind: "llm",
  fields: ["title", "descriptionHtml", "productType", "tags", "options", "attributes"],
  async run({ deps, listing, store, item }) {
    // 已确认类目时才尝试属性映射：懒拉取该类目的标准属性清单喂给 AI。
    const channelAttrs = listing.channelCategoryId
      ? await cachedCategoryAttributes(deps.db, deps, store, listing.channelCategoryId).catch(
          () => [] as ChannelAttribute[],
        )
      : [];

    const res = await meteredChatJson(
      deps,
      { workspaceId: listing.workspaceId, listingId: listing.id },
      {
        system: SYSTEM_PROMPT,
        user: buildUserPrompt({
          title: listing.title,
          attributes: item.attributes,
          priceText: item.priceText,
          options: listing.options,
          targetLang: store.language,
          channelAttrs,
        }),
      },
    );
    const out = res.data as EnhanceOutput;

    const proposals: StageProposal[] = [];
    if (
      typeof out.title === "string" &&
      out.title.trim() &&
      out.title.trim() !== listing.title
    ) {
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
      if (tags.length && !sameJson(tags, listing.tags))
        proposals.push({ field: "tags", value: tags });
    }
    if (Array.isArray(out.options) && out.options.length === listing.options.length) {
      const translated: ListingOption[] = out.options.map((o, i) => ({
        name:
          typeof o?.name === "string" && o.name.trim()
            ? o.name.trim()
            : listing.options[i]!.name,
        values: Array.isArray(o?.values)
          ? o.values.map((v, j) =>
              typeof v === "string" && v.trim()
                ? v.trim()
                : listing.options[i]!.values[j] ?? "",
            )
          : listing.options[i]!.values,
      }));
      if (!sameJson(translated, listing.options)) {
        const value: OptionsSuggestionValue = {
          options: translated,
          variantOptionValues: translatedVariantValues(
            listing.options,
            translated,
            listing.variants,
          ),
          sourceOptions: listing.options,
        };
        proposals.push({ field: "options", value });
      }
    }
    if (channelAttrs.length && Array.isArray(out.channelAttributes)) {
      const byId = new Map(channelAttrs.map((a) => [a.id, a]));
      const attributes: ChannelAttributeProposal[] = out.channelAttributes
        .map((p): ChannelAttributeProposal | null => {
          if (typeof p !== "object" || !p) return null;
          const attr = byId.get(String(p.attrId ?? ""));
          if (!attr) return null;
          let value = String(p.value ?? "").trim();
          if (!value) return null;
          // choice 属性：取值必须落在候选值里（大小写不敏感匹配回规范名）
          if (attr.kind === "choice" && attr.values?.length) {
            const hit = attr.values.find(
              (v) => v.name.toLowerCase() === value.toLowerCase(),
            );
            if (!hit) return null;
            value = hit.name;
          }
          return {
            sourceName: String(p.sourceName ?? "").slice(0, 200),
            sourceValue: String(p.sourceValue ?? "").slice(0, 500),
            attrId: attr.id,
            attrName: attr.name,
            value: value.slice(0, 500),
          };
        })
        .filter((p): p is ChannelAttributeProposal => !!p)
        .slice(0, 30);
      if (
        attributes.length &&
        !sameJson(
          attributes.map((a) => ({ attrId: a.attrId, value: a.value })),
          listing.channelAttributes.map((a) => ({ attrId: a.attrId, value: a.value })),
        )
      ) {
        const value: AttributesSuggestionValue = { attributes };
        proposals.push({ field: "attributes", value });
      }
    }

    await replaceStageSuggestions(deps.db, listing, enhanceStage, proposals);
  },
};
