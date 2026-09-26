import type {
  ListingFieldsSnapshot,
  ListingSyncPolicy,
  PublishErrorCode,
  RemoteDriftEntry,
  RemoteSnapshot,
  RemoteStatus,
} from "@caiji/shared";
import type { ListingRow } from "../channels/types.js";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** 发布时冻结进 attempt 的字段快照（重试时按当版重新冻结）。 */
export function toFieldsSnapshot(l: ListingRow): ListingFieldsSnapshot {
  return {
    title: l.title,
    descriptionHtml: l.descriptionHtml,
    images: l.images,
    descImages: l.descImages,
    options: l.options,
    variants: l.variants,
    tags: l.tags,
    productType: l.productType,
    vendor: l.vendor,
    weightKg: l.weightKg,
    channelCategoryId: l.channelCategoryId,
    channelCategoryName: l.channelCategoryName,
    channelAttributes: l.channelAttributes,
  };
}

/** 发布成功后写回 remoteSnapshot 的「我们刚推送的本地内容」快照。 */
export function pushedSnapshot(
  l: ListingRow,
  remoteId: string,
  status: RemoteStatus | undefined,
): RemoteSnapshot {
  return {
    remoteId,
    status: status ?? "ACTIVE",
    title: l.title,
    descriptionHtml: l.descriptionHtml,
    variants: l.variants.map((v) => ({
      sku: v.sku || null,
      optionValues: v.optionValues,
      price: v.price.toFixed(2),
      stock: v.stock ?? null,
    })),
    fetchedAt: new Date().toISOString(),
  };
}

/** 远端变体按 sku 对齐本地变体（仅本地无 sku 才按下标兜底；
 *  本地有 sku 但远端找不到 → 返回 undefined，不拿别的变体比）。 */
function remoteVariantFor(
  snap: NonNullable<RemoteSnapshot["variants"]>,
  local: ListingRow["variants"][number],
  index: number,
) {
  if (local.sku) {
    return snap.find((v) => v.sku === local.sku);
  }
  return snap[index];
}

/** 描述规范化：剥空段落、压空白（双侧一致）。 */
function normDesc(s: string): string {
  return norm(s.replace(/<p>\s*<\/p>/gi, ""));
}

/** 远端描述 = 本地 descriptionHtml + 发布时追加的 descImages 渲染块（`<p><img cdn></p>` × n）。
 *  只剥末尾至多 n 个这样的块；描述内用户自己写的 <img> 保留参与比较，商家改动仍会报漂移。 */
function stripAppendedDescImages(html: string, n: number): string {
  if (n <= 0) return html;
  return html.replace(
    new RegExp(`(?:<p>\\s*<img\\b[^>]*>\\s*</p>\\s*){1,${n}}$`, "i"),
    "",
  );
}

/**
 * 字段级漂移：本地刊登 vs 远端快照。只标记（title/description/price/stock），
 * 是否处理由 syncPolicy 与调用方决定——本函数永不做写操作。
 * 快照缺的字段不参与比较（adapter 只拉了部分字段时不误报）。
 */
export function computeDrift(l: ListingRow, snap: RemoteSnapshot): RemoteDriftEntry[] {
  const drift: RemoteDriftEntry[] = [];
  if (snap.title !== undefined && norm(snap.title) !== norm(l.title)) {
    drift.push({ field: "title", local: l.title, remote: snap.title });
  }
  if (
    snap.descriptionHtml !== undefined &&
    normDesc(stripAppendedDescImages(snap.descriptionHtml, l.descImages.length)) !==
      normDesc(l.descriptionHtml)
  ) {
    drift.push({
      field: "descriptionHtml",
      local: l.descriptionHtml,
      remote: snap.descriptionHtml,
    });
  }
  if (snap.variants) {
    const remotePrices: string[] = [];
    const localPrices: string[] = [];
    const remoteStocks: Array<number | null> = [];
    const localStocks: Array<number | null> = [];
    l.variants.forEach((v, i) => {
      const rv = remoteVariantFor(snap.variants!, v, i);
      if (!rv) return;
      if (rv.price !== undefined) {
        localPrices.push(v.price.toFixed(2));
        remotePrices.push(rv.price);
      }
      if (rv.stock !== undefined) {
        localStocks.push(v.stock ?? null);
        remoteStocks.push(rv.stock);
      }
    });
    if (localPrices.some((p, i) => p !== remotePrices[i])) {
      drift.push({ field: "price", local: localPrices, remote: remotePrices });
    }
    if (localStocks.some((s, i) => s !== remoteStocks[i])) {
      drift.push({ field: "stock", local: localStocks, remote: remoteStocks });
    }
  }
  return drift;
}

/** drift 字段 → syncPolicy 类别（title/descriptionHtml 都归 content）。 */
const DRIFT_POLICY: Record<string, keyof ListingSyncPolicy> = {
  title: "content",
  descriptionHtml: "content",
  price: "price",
  stock: "stock",
};

/** 按刊登的 syncPolicy 过滤漂移：策略为 off 的类别不记录、不提示。 */
export function filterDriftByPolicy(
  drift: RemoteDriftEntry[],
  policy: ListingSyncPolicy,
): RemoteDriftEntry[] {
  return drift.filter((d) => policy[DRIFT_POLICY[d.field] ?? "content"] !== "off");
}

/** 平台原文错误 → 可归一化 code（attempt.errorCode）。 */
export function normalizePublishError(message: string): PublishErrorCode {
  const m = message.toLowerCase();
  if (/not.?found|deleted|不存在|已删除/.test(m)) return "remote_deleted";
  if (/auth|token|unauthorized|401|access denied|invalid.*(token|key)|expired|授权/.test(m))
    return "auth_expired";
  if (/rate.?limit|throttl|429|too many|限流/.test(m)) return "rate_limited";
  if (/review|审核|reject|违规|禁售/.test(m)) return "review_rejected";
  return "unknown";
}
