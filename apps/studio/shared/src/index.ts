/** Frozen contract types for the 铺货 workbench (apps/studio).
 *  Server and web both consume these; do not rename or reshape casually —
 *  this file IS the interface freeze. */

// ---------- ids ----------
export type PlatformId = "shopee" | "tiktok";

// ---------- Shop ----------
export type ShopAuthStatus = "authorized" | "expired";

export interface Shop {
  id: string;
  platform: PlatformId;
  /** 站点/国家，如 MY、SG、US、UK；同一平台下可有多个站点店铺。 */
  site: string;
  name: string;
  authStatus: ShopAuthStatus;
  /** mock 授权的外部店铺 id */
  externalId: string | null;
  createdAt: string;
}

// ---------- Product（货源主数据） ----------
export interface ProductVariant {
  sku: string;
  /** { "Color": "Red", "Size": "M" } */
  options: Record<string, string>;
  price: number;
  stock: number;
  /** UPC/GTIN/EAN 等识别码 */
  upc: string | null;
}

export type ProductSource = "manual" | "import" | "link";

export interface Product {
  id: string;
  source: ProductSource;
  sourceUrl: string | null;
  title: string;
  images: string[];
  variants: ProductVariant[];
  /** 货源原始类目路径，如 "服装/女装/T恤" */
  sourceCategory: string | null;
  createdAt: string;
}

// ---------- ListingDraft（主稿，可编辑、AI 作用于字段级） ----------
export type DraftStatus = "draft" | "ready";

export interface DraftFields {
  title: string;
  /** 卖点（bullet points） */
  bullets: string[];
  description: string;
  /** 平台中性的属性集 { 名: 值 } */
  attributes: Record<string, string>;
  /** 主稿定价；铺到各店时按店铺规则换算（本期直接沿用） */
  price: number;
  compareAtPrice: number | null;
  /** 类目：平台中性路径 + 每平台映射由 channel check 校验 */
  category: string | null;
  upc: string | null;
}

export interface ListingDraft {
  id: string;
  productId: string;
  status: DraftStatus;
  fields: DraftFields;
  /** AI 最近写入过哪些字段（时间戳），用于 UI 标记 */
  aiFields: string[];
  updatedAt: string;
}

// ---------- 渠道校验 / 预览 ----------
export type IssueCode =
  | "missing_field"
  | "too_long"
  | "invalid_value"
  | "banned_term"
  | "category_unmapped"
  | "auth_expired"
  | "rate_limited"
  | "platform_rejected";

export interface ChannelIssue {
  code: IssueCode;
  /** 出问题的字段（title/attributes/category/images/upc/auth…） */
  field: string;
  message: string;
  /** 在该草稿/字段上能不能直接修 */
  fixable: boolean;
}

export interface ChannelCheck {
  shopId: string;
  platform: PlatformId;
  site: string;
  shopName: string;
  ok: boolean;
  issues: ChannelIssue[];
}

// ---------- PublishJob / PublishAttempt ----------
export type JobStatus = "queued" | "running" | "partial_success" | "succeeded" | "failed";
export type AttemptStatus = "queued" | "running" | "review" | "succeeded" | "failed";

export interface PublishJob {
  id: string;
  productId: string;
  draftId: string;
  status: JobStatus;
  /** 创建时冻结的字段版本（审计用） */
  fieldsSnapshot: DraftFields;
  shopIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublishAttempt {
  id: string;
  jobId: string;
  shopId: string;
  status: AttemptStatus;
  /** 失败原因（面向用户的短语��� */
  error: string | null;
  /** 结构化失败信息（缺哪些字段等） */
  issues: ChannelIssue[];
  /** mock 回写 */
  externalId: string | null;
  remoteUrl: string | null;
  retryOf: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- AuditLog ----------
export interface AuditLog {
  id: string;
  actor: string;
  action: string; // "product.create" | "draft.ai" | "publish.create" | "attempt.retry" ...
  entityType: "product" | "draft" | "job" | "attempt" | "shop";
  entityId: string;
  /** 当次写入了哪版文案/字段（冻结快照） */
  payload: Record<string, unknown>;
  createdAt: string;
}

// ---------- AI 字段级动作 ----------
export type AiField = "title" | "description" | "bullets" | "attributes" | "pricing";
export type AiMode =
  | "generate"
  | "shorter"
  | "more_converting"
  | "category_fill"
  | "margin_suggest"
  | "channel_rewrite";

// ---------- API payloads ----------
export interface Page<T> {
  items: T[];
  total: number;
}

export interface PublishRequest {
  productId: string;
  shopIds: string[];
}

export interface PublishJobDetail {
  job: PublishJob;
  attempts: PublishAttempt[];
}

export interface PlatformMeta {
  id: PlatformId;
  name: string;
  sites: string[];
}
