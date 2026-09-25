import type { Deps } from "../context.js";
import type { Product } from "@studio/shared";

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

export declare function importCsv(
  deps: Deps,
  text: string,
): Promise<{ created: Product[]; errors: { row: number; message: string }[] }>;

export declare function productFromUrl(deps: Deps, url: string): Promise<Product>;

export declare function seedDemo(deps: Deps): Promise<void>;
