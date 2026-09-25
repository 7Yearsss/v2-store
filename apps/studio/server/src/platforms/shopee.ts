import type { ChannelIssue } from "@studio/shared";
import { HttpError } from "../lib/errors.js";
import type { PlatformAdapter } from "./types.js";

// 规则来自 docs/studio-phase0.md 的 Shopee 拆解：
// 标题 ≤255 实际建议 ≤60；图 1–9 张、封面必有；类目必填属性（模拟 Brand）；
// 禁售词表；价格按站点币种（>0）。
const TITLE_MAX = 255;
const IMAGE_MAX = 9;
const BANNED_TERMS = ["假货", "高仿", "official store", "正品代购"];

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
          message: `${label}包含禁售词「${term}」`,
          fixable: true,
        });
      }
    }
  }
  return hits;
}

export const shopeeAdapter: PlatformAdapter = {
  id: "shopee",
  name: "Shopee",
  sites: ["MY", "SG", "PH", "TH", "TW"],

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
      // >60 只算建议项（phase0 调研），不落 issue，对照卡仍 ok
      issues.push({
        code: "too_long",
        field: "title",
        message: `标题超过 ${TITLE_MAX} 字符上限（当前 ${title.length}）`,
        fixable: true,
      });
    }

    const images = product.images.length;
    if (images < 1) {
      issues.push({
        code: "missing_field",
        field: "images",
        message: "至少需要 1 张商品图（封面必传）",
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
        message: "类目未映射到 Shopee 类目",
        fixable: true,
      });
    }

    issues.push(...bannedIssues(fields));

    if (!fields.attributes["Brand"]?.trim()) {
      issues.push({
        code: "missing_field",
        field: "attributes.Brand",
        message: "缺少类目必填属性 Brand",
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
    // 演示逃生口：标题含 [FAIL]（或 [FAIL:shopee]）→ 本侧平台拒绝。
    // [FAIL] 只命中本 adapter：验收要求多店任务里它造成部分失败、
    // 其他平台照常成功（partial_success）；[FAIL:<platform>] 可精确指定。
    if (fields.title.includes("[FAIL]") || fields.title.includes("[FAIL:shopee]")) {
      throw new HttpError(422, "平台拒绝：模拟失败");
    }
    const externalId = `SP-${seedHex(product.id, shop.id)}`;
    return {
      status: "succeeded",
      externalId,
      remoteUrl: `https://shopee.${shop.site.toLowerCase()}/product/${externalId}`,
    };
  },
};
