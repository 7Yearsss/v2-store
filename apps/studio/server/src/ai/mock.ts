import type { AiField, AiMode, DraftFields, PlatformId } from "@studio/shared";

/** runFieldAi 的输入（services/ai.ts 与 mock/llm 两条实现共用）。 */
export interface AiInput {
  field: AiField;
  mode: AiMode;
  channel?: PlatformId;
  fields: DraftFields;
  productTitle: string;
  sourceCategory: string | null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => collapse(s).slice(0, n).trim();
const round2 = (n: number) => Math.round(n * 100) / 100;

function categoryLeaf(sourceCategory: string | null): string {
  const leaf = sourceCategory?.split("/").filter(Boolean).pop()?.trim();
  return leaf ? leaf : "新款";
}

// ---------- title ----------
function mockTitle(input: AiInput): string {
  const base = input.fields.title || input.productTitle;
  switch (input.mode) {
    case "shorter":
      return clip(base, 40);
    case "more_converting": {
      const tag = input.productTitle.length % 2 === 0 ? "Hot Sale" : "2025 New";
      return `${tag} ${clip(base, 50)}`.trim();
    }
    default:
      return `${clip(input.productTitle, 60)} ${categoryLeaf(input.sourceCategory)}`.trim();
  }
}

// ---------- bullets ----------
const GENERIC_SELLING_POINTS = [
  "品质保障，严选好货",
  "跨境热卖，回购率高",
  "现货速发，48小时内发出",
  "售后无忧，支持退换",
  "高性价比，批发价直供",
];

function mockBullets(input: AiInput): string[] {
  const attrBullets = Object.entries(input.fields.attributes)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  return [...attrBullets, ...GENERIC_SELLING_POINTS].slice(0, 5);
}

// ---------- description ----------
const SHOPEE_EMOJI = ["💖", "🌸", "🔥", "🎀", "⭐"];

function channelRewrite(input: AiInput, channel: PlatformId): string {
  const title = input.fields.title || input.productTitle;
  const bullets = input.fields.bullets.length ? input.fields.bullets : mockBullets(input);
  if (channel === "shopee") {
    return [
      `✨ ${clip(title, 60)} ✨`,
      "",
      ...bullets.map((b, i) => `${SHOPEE_EMOJI[i % SHOPEE_EMOJI.length]} ${b}`),
      "",
      "🛒 现货速发，东南亚本地仓直发，物流超快～",
      "💗 喜欢的姐妹赶紧下单，手慢无！",
    ].join("\n");
  }
  // tiktok：短句 + 带货语气
  return [
    `🔥 ${clip(title, 50)}`,
    "",
    ...bullets.slice(0, 3).map((b) => `✔️ ${b}`),
    "",
    "点下方小黄车，直播间专属价，先到先得！",
  ].join("\n");
}

function mockDescription(input: AiInput): string {
  if (input.mode === "channel_rewrite" && input.channel) {
    return channelRewrite(input, input.channel);
  }
  const title = input.fields.title || input.productTitle;
  const bullets = input.fields.bullets.length ? input.fields.bullets : mockBullets(input);
  const cat = input.sourceCategory ? `（${input.sourceCategory}）` : "";
  return [
    `${title}${cat}`,
    "",
    "【产品卖点】",
    ...bullets.map((b) => `· ${b}`),
    "",
    "【尺码提示】标准尺码，若介于两码之间建议选大一码；手工测量存在 1-2cm 误差。",
    "【售后说明】支持 7 天无理由退换；质量问题包退包换，请联系在线客服。",
  ].join("\n");
}

// ---------- attributes ----------
function classifyAttributes(cat: string): Record<string, string> | null {
  if (/电子|耳机|数码|充电|电池|蓝牙/.test(cat)) {
    return { Battery: "内置锂电池", Connectivity: "蓝牙5.3", Warranty: "12个月质保" };
  }
  if (/裙|衣|裤|衫|服|外套/.test(cat)) {
    return { Material: "棉混纺", Pattern: "纯色", Sleeve: "常规袖", Style: "休闲" };
  }
  if (/家居|收纳|厨房|杯|床|架/.test(cat)) {
    return { Material: "环保材质", Style: "现代简约", Occasion: "客厅/卧室" };
  }
  return null;
}

function mockAttributes(input: AiInput): Record<string, string> {
  // 以 fields.category 为主判断，sourceCategory 兜底
  const suggested =
    classifyAttributes(input.fields.category ?? "") ??
    classifyAttributes(input.sourceCategory ?? "") ??
    { Material: "优质材质", Style: "通用", Occasion: "日常" };
  // 补齐语义：已有属性优先，建议值只填空位
  return { ...suggested, ...input.fields.attributes };
}

// ---------- pricing ----------
function mockPricing(input: AiInput): { price: number } {
  // 稿价即货源成本基线：成本 ×2.2 倒推售价；无成本时退化为现价 ×1.15
  const cost = input.fields.price;
  if (cost > 0) return { price: round2(cost * 2.2) };
  const current = input.fields.compareAtPrice ?? 0;
  return { price: current > 0 ? round2(current * 1.15) : 0 };
}

/** 确定性 mock：同输入同输出，无随机。 */
export function mockFieldAi(input: AiInput): Partial<DraftFields> {
  switch (input.field) {
    case "title":
      return { title: mockTitle(input) };
    case "description":
      return { description: mockDescription(input) };
    case "bullets":
      return { bullets: mockBullets(input) };
    case "attributes":
      return { attributes: mockAttributes(input) };
    case "pricing":
      return mockPricing(input);
  }
}
