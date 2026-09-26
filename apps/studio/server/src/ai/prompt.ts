import type { AiField, AiMode, DraftFields, PlatformId } from "@studio/shared";
import type { AiInput } from "./mock.js";

// LLM 侧约定：只回一个 JSON 对象，形状按字段固定。
// prompt 组装与返回解析放同一文件，保证"要什么形状"只有一处定义。

const FIELD_SHAPES: Record<AiField, string> = {
  title: '{"title": "<string>"}',
  description: '{"description": "<string>"}',
  bullets: '{"bullets": ["<string>", "..."]}',
  attributes: '{"attributes": {"<Name>": "<Value>"}}',
  pricing: '{"price": <number>}',
};

const MODE_TASKS: Record<AiMode, string> = {
  generate: "Generate this field from the source product data.",
  shorter: "Rewrite the title shorter, keeping the key selling points.",
  more_converting:
    "Rewrite the title to be more conversion-oriented (hot words, urgency, value).",
  category_fill: "Fill in the attributes buyers expect for this category.",
  margin_suggest: "Suggest a retail price by back-calculating platform fees and margin.",
  channel_rewrite: "Rewrite the description in the target channel's tone.",
};

const PLATFORM_NAMES: Record<PlatformId, string> = {
  shopee: "Shopee",
  tiktok: "TikTok Shop",
};

const SYSTEM_PROMPT = [
  "You are a cross-border e-commerce listing copywriter.",
  "You write concise, conversion-focused English copy for overseas marketplaces",
  "(Shopee Southeast Asia, TikTok Shop US).",
  "Reply with a single JSON object only — no prose, no markdown fences.",
].join(" ");

export function buildPrompt(input: AiInput): { system: string; user: string } {
  const lines = [
    `Task: ${MODE_TASKS[input.mode]}`,
    `Field: ${input.field}`,
    input.channel ? `Target channel: ${PLATFORM_NAMES[input.channel]}` : null,
    `Source product title (Chinese): ${input.productTitle}`,
    `Source category: ${input.sourceCategory ?? "unknown"}`,
    `Current draft fields (JSON): ${JSON.stringify(input.fields)}`,
    "",
    "Translate and adapt the Chinese source info into natural English for the target market.",
    `Reply in exactly this JSON shape: ${FIELD_SHAPES[input.field]}`,
  ];
  return { system: SYSTEM_PROMPT, user: lines.filter((l) => l !== null).join("\n") };
}

function asStringRecord(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof k !== "string" || (typeof val !== "string" && typeof val !== "number")) {
      return null;
    }
    out[k] = String(val);
  }
  return out;
}

/** 解析模型返回的 JSON 文本；任何一步不合格都返回 null（调用方降级 mock）。 */
export function parseAiJson(field: AiField, content: string): Partial<DraftFields> | null {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  switch (field) {
    case "title":
      return typeof r.title === "string" && r.title.trim() ? { title: r.title.trim() } : null;
    case "description":
      return typeof r.description === "string" && r.description.trim()
        ? { description: r.description.trim() }
        : null;
    case "bullets": {
      if (!Array.isArray(r.bullets)) return null;
      const bullets = r.bullets
        .filter((b): b is string => typeof b === "string")
        .map((b) => b.trim())
        .filter(Boolean)
        .slice(0, 10);
      return bullets.length ? { bullets } : null;
    }
    case "attributes": {
      const attributes = asStringRecord(r.attributes);
      return attributes && Object.keys(attributes).length ? { attributes } : null;
    }
    case "pricing": {
      const price = typeof r.price === "number" ? r.price : Number(r.price);
      return Number.isFinite(price) && price >= 0 ? { price: Math.round(price * 100) / 100 } : null;
    }
  }
}
