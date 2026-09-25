import type { Deps } from "../context.js";
import type { Product, ProductVariant } from "@studio/shared";
import { products, shops } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { ensureDraft, toProduct } from "./draft.js";

// ============================================================
// child-ai-seed 拥有本文件实现。签名冻结。
// 语义：
// - importCsv：解析粘贴的 CSV/表格文本 → 逐行建 product(source:"import")；
//   返回 {created: Product[], errors: {row, message}[]}，
//   部分行失败不阻断（行级错误回给 UI）
// - productFromUrl：货源链接 → product(source:"link")。mock 解析：
//   按 host 返回确定性的示例货源（1688/taobao/tmall…），
//   不认识的 host → 400。不要做真爬取。
// - seedDemo：幂等建示例数据——3 间示例店铺（shopee MY/SG、tiktok US，
//   其中一间 authStatus:"expired" 演示过期态）、6 个示例商品、
//   每个商品一条初始化主稿。启动时调用一次（有数据则跳过）。
// ============================================================

const picsum = (seed: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `https://picsum.photos/seed/${seed}-${i + 1}/600/600`);

const variant = (
  sku: string,
  options: Record<string, string>,
  price: number,
  stock: number,
  upc: string | null = null,
): ProductVariant => ({ sku, options, price, stock, upc });

// ---------- importCsv ----------

const CSV_HEADERS = ["title", "price", "stock", "sku", "images", "category"] as const;
type CsvHeader = (typeof CSV_HEADERS)[number];

/** 单行切分：制表符行按 \t，否则按 ,；双引号字段包裹内容（不解析转义，够用）。 */
function splitLine(line: string): string[] {
  const sep = line.includes("\t") ? "\t" : ",";
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === sep && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw.replace(/[¥$,，\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseStock(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function importCsv(
  deps: Deps,
  text: string,
): Promise<{ created: Product[]; errors: { row: number; message: string }[] }> {
  const created: Product[] = [];
  const errors: { row: number; message: string }[] = [];

  const lines = text
    .split(/\r?\n/)
    .map((line, idx) => ({ line, row: idx + 1 }))
    .filter((l) => l.line.trim() !== "");
  if (!lines.length) return { created, errors };

  // 表头行：字段里出现 title 即视为表头；否则前两列 = title,price
  const firstCols = splitLine(lines[0].line).map((c) => c.toLowerCase());
  const headerIdx = new Map<CsvHeader, number>();
  let dataLines = lines;
  if (firstCols.includes("title")) {
    for (const h of CSV_HEADERS) {
      const i = firstCols.indexOf(h);
      if (i >= 0) headerIdx.set(h, i);
    }
    dataLines = lines.slice(1);
  }

  const col = (cols: string[], h: CsvHeader, pos: number): string | undefined =>
    headerIdx.size ? cols[headerIdx.get(h) ?? -1] : cols[pos];

  for (const { line, row } of dataLines) {
    const cols = splitLine(line);
    const title = col(cols, "title", 0)?.trim() ?? "";
    const price = parsePrice(col(cols, "price", 1));
    const stock = parseStock(col(cols, "stock", 2));
    const sku = col(cols, "sku", 3)?.trim() ?? "";
    const images = (col(cols, "images", 4) ?? "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    const category = col(cols, "category", 5)?.trim() || null;

    if (!title) {
      errors.push({ row, message: "标题为空" });
      continue;
    }
    if (price === null) {
      errors.push({ row, message: `价格解析失败：${col(cols, "price", 1) ?? ""}` });
      continue;
    }
    if (stock === null) {
      errors.push({ row, message: `库存解析失败：${col(cols, "stock", 2) ?? ""}` });
      continue;
    }

    const [p] = await deps.db
      .insert(products)
      .values({
        source: "import",
        title,
        images,
        variants: [variant(sku, {}, price, stock)],
        sourceCategory: category,
      })
      .returning();
    await ensureDraft(deps.db, p.id);
    created.push(toProduct(p));
  }
  return { created, errors };
}

// ---------- productFromUrl ----------

type LinkKind = "1688" | "taobao" | "tmall";

function detectKind(host: string): LinkKind | null {
  if (host.includes("1688")) return "1688";
  if (host.includes("taobao")) return "taobao";
  if (host.includes("tmall")) return "tmall";
  return null;
}

/** 不同 host 返回不同的确定性示例货源（同链接 → 同图片种子）。 */
const LINK_SAMPLES: Record<LinkKind, (seed: string) => {
  title: string;
  images: string[];
  variants: ProductVariant[];
  sourceCategory: string;
}> = {
  "1688": (seed) => ({
    title: "2025新款夏季女装连衣裙 韩版收腰显瘦A字裙 源头厂货",
    images: picsum(`${seed}-a`, 4),
    variants: [
      variant(`1688-${seed}-S`, { 颜色: "碎花蓝", 尺码: "S" }, 35.9, 500),
      variant(`1688-${seed}-M`, { 颜色: "碎花蓝", 尺码: "M" }, 35.9, 800, "6901234500011"),
      variant(`1688-${seed}-L`, { 颜色: "碎花红", 尺码: "L" }, 38.5, 300),
    ],
    sourceCategory: "女装/裙装/连衣裙",
  }),
  taobao: (seed) => ({
    title: "ins风陶瓷马克杯 大容量早餐杯 北欧简约家用",
    images: picsum(`${seed}-b`, 3),
    variants: [
      variant(`TB-${seed}-W`, { 颜色: "奶白" }, 19.9, 200, "6901234500028"),
      variant(`TB-${seed}-G`, { 颜色: "雾灰" }, 21.9, 150),
    ],
    sourceCategory: "家居/厨房/杯壶",
  }),
  tmall: (seed) => ({
    title: "无线蓝牙耳机5.3 入耳式降噪运动跑步长续航正品",
    images: picsum(`${seed}-c`, 5),
    variants: [
      variant(`TM-${seed}-BK`, { 颜色: "曜石黑" }, 89, 400, "6901234500035"),
      variant(`TM-${seed}-WH`, { 颜色: "珍珠白" }, 89, 600),
      variant(`TM-${seed}-PK`, { 颜色: "樱花粉" }, 99, 120),
    ],
    sourceCategory: "3C数码/影音/蓝牙耳机",
  }),
};

export async function productFromUrl(deps: Deps, url: string): Promise<Product> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw badRequest("无效的货源链接");
  }
  const kind = detectKind(host);
  if (!kind) throw badRequest("暂不支持的货源链接，目前支持 1688/淘宝/天猫");

  const seed = String(Math.abs(hash(url)));
  const sample = LINK_SAMPLES[kind](seed);
  const [p] = await deps.db
    .insert(products)
    .values({ source: "link", sourceUrl: url, ...sample })
    .returning();
  await ensureDraft(deps.db, p.id);
  return toProduct(p);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ---------- seedDemo ----------

const DEMO_SHOPS = [
  { platform: "shopee" as const, site: "MY", name: "马来旗舰店", authStatus: "authorized" as const, externalId: "shp-my-8801" },
  { platform: "shopee" as const, site: "SG", name: "新加坡店", authStatus: "authorized" as const, externalId: "shp-sg-8802" },
  { platform: "tiktok" as const, site: "US", name: "美国店", authStatus: "expired" as const, externalId: "tts-us-6601" },
];

const DEMO_PRODUCTS: {
  title: string;
  imageSeed: string;
  imageCount: number;
  variants: ProductVariant[];
  sourceCategory: string;
}[] = [
  {
    title: "2025夏季新款法式碎花连衣裙 收腰显瘦中长款",
    imageSeed: "101",
    imageCount: 4,
    variants: [
      variant("DRS-S", { 颜色: "碎花蓝", 尺码: "S" }, 39.9, 300),
      variant("DRS-M", { 颜色: "碎花蓝", 尺码: "M" }, 39.9, 500, "6901000101014"),
      variant("DRS-L", { 颜色: "碎花红", 尺码: "L" }, 42.9, 200),
    ],
    sourceCategory: "女装/裙装/连衣裙",
  },
  {
    title: "男士纯棉短袖T恤 韩版宽松纯色半袖打底衫",
    imageSeed: "102",
    imageCount: 3,
    variants: [
      variant("TEE-W-M", { 颜色: "白色", 尺码: "M" }, 25.9, 800, "6901000101021"),
      variant("TEE-B-L", { 颜色: "黑色", 尺码: "L" }, 25.9, 600),
    ],
    sourceCategory: "男装/上装/T恤",
  },
  {
    title: "无线蓝牙耳机5.3 入耳式降噪运动跑步长续航",
    imageSeed: "103",
    imageCount: 5,
    variants: [
      variant("BUD-BK", { 颜色: "曜石黑" }, 79, 400, "6901000101038"),
      variant("BUD-WH", { 颜色: "珍珠白" }, 79, 650),
      variant("BUD-PK", { 颜色: "樱花粉" }, 89, 100),
    ],
    sourceCategory: "3C数码/影音/蓝牙耳机",
  },
  {
    title: "65W氮化镓快充充电器 多口PD快充头适用苹果安卓",
    imageSeed: "104",
    imageCount: 3,
    variants: [
      variant("GAN65-1C", { 规格: "单C口" }, 49.9, 300, "6901000101045"),
      variant("GAN65-2C", { 规格: "双C口" }, 59.9, 250),
    ],
    sourceCategory: "3C数码/配件/充电器",
  },
  {
    title: "北欧风陶瓷马克杯 大容量咖啡杯早餐杯家用简约",
    imageSeed: "105",
    imageCount: 4,
    variants: [
      variant("MUG-W", { 颜色: "奶白" }, 22.9, 400, "6901000101052"),
      variant("MUG-G", { 颜色: "雾灰" }, 24.9, 260),
      variant("MUG-GN", { 颜色: "抹茶绿" }, 24.9, 180),
    ],
    sourceCategory: "家居/厨房/杯壶",
  },
  {
    title: "免打孔浴室置物架 太空铝壁挂式三角收纳架",
    imageSeed: "106",
    imageCount: 3,
    variants: [
      variant("RACK-1", { 规格: "单层" }, 29.9, 350),
      variant("RACK-2", { 规格: "双层" }, 45.9, 220, "6901000101069"),
    ],
    sourceCategory: "家居/收纳/置物架",
  },
];

/** 幂等：shops 表非空即视为已 seed，整体跳过。 */
export async function seedDemo(deps: Deps): Promise<void> {
  const existing = await deps.db.query.shops.findFirst();
  if (existing) return;

  await deps.db.insert(shops).values(DEMO_SHOPS);
  for (const p of DEMO_PRODUCTS) {
    const [row] = await deps.db
      .insert(products)
      .values({
        source: "manual",
        title: p.title,
        images: picsum(p.imageSeed, p.imageCount),
        variants: p.variants,
        sourceCategory: p.sourceCategory,
      })
      .returning();
    await ensureDraft(deps.db, row.id);
  }
}
