import type { ChannelIssue } from "@studio/shared";
import { HttpError } from "../lib/errors.js";
import type { PlatformAdapter } from "./types.js";

// 规则来自 docs/studio-phase0.md 的 TikTok Shop 拆解：
// 标题 ≤80 字符为优；图 ≥5 张建议 ≤9；类目映射；识别码（UPC）强制；
// 变体 ≤300；引流类禁售词；发布落地常态"审核中"(review)。
const TITLE_MAX = 80;
const IMAGE_MIN = 5;
const IMAGE_MAX = 9;
const VARIANT_MAX = 300;
const BANNED_TERMS = ["whatsapp", "facebook", "contact me"];

/** productId+shopId 种子 → 8 位稳定 hex（同输入同输出，测试可断言）。 */
function seedHex(...parts: string[]): string {
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function bannedIssues(fields: { title: string; description: string; bullets: string[] }): ChannelIssue[] {
  const hits: ChannelIssue[] = [];
  const scan: [string, string, string][] = [
    ["title", "标题", fields.title],
    ["description", "描述", fields.description],
    ["bullets", "卖点", fields.bullets.join("\n")],
  ];
  for (const [field, label, text] of scan) {
    const low = text.toLowerCase();
    for (const term of BANNED_TERMS) {
      if (low.includes(term.toLowerCase())) {
        hits.push({
          code: "banned_term",
          field,
          message: `${label}包含禁售词「${term}」（引流词 TikTok 禁售）`,
          fixable: true,
        });
      }
    }
  }
  return hits;
}

export const tiktokAdapter: PlatformAdapter = {
  id: "tiktok",
  name: "TikTok Shop",
  sites: ["US", "UK", "MY", "SG", "PH", "TH", "VN"],

  validateDraft({ product, fields, shop }): ChannelIssue[] {
    const issues: ChannelIssue[] = [];

    if (shop.authStatus === "expired") {
      issues.push({
        code: "auth_expired",
        field: "auth",
        message: "店铺授权已过期，需重新授权",
        fixable: false,
      });
    }

    const title = fields.title.trim();
    if (!title) {
      issues.push({ code: "missing_field", field: "title", message: "标题不能为空", fixable: true });
    } else if (title.length > TITLE_MAX) {
      issues.push({
        code: "too_long",
        field: "title",
        message: `TikTok 标题建议 ≤80 字符（当前 ${title.length}）`,
        fixable: true,
      });
    }

    const images = product.images.length;
    if (images < IMAGE_MIN) {
      issues.push({
        code: "missing_field",
        field: "images",
        message: `TikTok 建议 ≥5 张图（当前 ${images}）`,
        fixable: true,
      });
    } else if (images > IMAGE_MAX) {
      issues.push({
        code: "too_long",
        field: "images",
        message: `商品图最多 ${IMAGE_MAX} 张（当前 ${images}）`,
        fixable: true,
      });
    }

    if (!fields.category?.trim()) {
      issues.push({
        code: "category_unmapped",
        field: "category",
        message: "类目未映射到 TikTok 类目",
        fixable: true,
      });
    }

    issues.push(...bannedIssues(fields));

    if (product.variants.length > VARIANT_MAX) {
      issues.push({
        code: "invalid_value",
        field: "variants",
        message: `变体数超过 ${VARIANT_MAX} 上限（当前 ${product.variants.length}）`,
        fixable: true,
      });
    }

    if (!fields.upc?.trim()) {
      issues.push({
        code: "missing_field",
        field: "upc",
        message: "缺少商品识别码 UPC（TikTok 强制）",
        fixable: true,
      });
    }

    if (fields.price <= 0) {
      issues.push({
        code: "invalid_value",
        field: "price",
        message: `价格必须大于 0（当前 ${fields.price}）`,
        fixable: true,
      });
    }

    return issues;
  },

  async publish(deps, { product, fields, shop }) {
    await new Promise((r) => setTimeout(r, deps.config.mock.publishDelayMs));
    // 演示逃生口：[FAIL:tiktok] → 本侧平台拒绝；跨平台共用标记 [FAIL]
    // 由 shopee 侧承接（多店任务里用于演示 partial_success）。
    if (fields.title.includes("[FAIL:tiktok]")) {
      throw new HttpError(422, "平台拒绝：模拟失败");
    }
    const externalId = `TT-${seedHex(product.id, shop.id)}`;
    return {
      status: "review",
      externalId,
      remoteUrl: `https://seller.tiktokglobalshop.com/product/${externalId}`,
    };
  },
};
