export type SourcePlatform =
  | "1688"
  | "taobao"
  | "pdd"
  | "temu"
  | "amazon"
  | "unknown";

/** One sellable variant row ("红色 / XL" flattened spec text). */
export interface OfferSku {
  skuId?: string;
  spec: string;
  priceCny?: number;
  stock?: number;
}

/** Raw payload the browser extension posts to POST /api/collect. */
export interface CollectedOffer {
  sourcePlatform: SourcePlatform;
  sourceUrl: string;
  offerId?: string;
  title: string;
  priceText?: string;
  skus: OfferSku[];
  images: string[];
  attributes: Record<string, string>;
  categoryPath?: string[];
  sellerName?: string;
  collectedAt: string; // ISO
}

export type ProductStatus = "draft" | "processed" | "listed";

/** Canonical product record stored server-side. */
export interface Product extends CollectedOffer {
  id: string;
  status: ProductStatus;
  /** 认领到的目标渠道（刊登模型里的"认领"动作）。 */
  targetChannel?: "shopify" | "shopee" | "tiktok" | "woocommerce";
  aiTitle?: string;
  aiDescription?: string;
  processedAt?: string;
}

export interface CollectResponse {
  ok: boolean;
  product: Product;
  duplicated: boolean;
}

// --- harvest contract (miaoshou-style: page side收割, server side解析) -------

/** Identity tokens pulled from a source URL — the unit of work for collection. */
export interface SourceInfo {
  itemUrl: string;
  itemId?: string;
  /** sub-site discriminator for multi-domain sources (e.g. www vs factory). */
  site?: string;
  source: SourcePlatform;
  postFee?: string;
}

export type AntiCode =
  | "notLogin"
  | "needVerifySecurity"
  | "rowDataInvalid";

/**
 * What the extension posts to POST /api/collect: raw page HTML + URL tokens.
 * Field extraction happens server-side so site adaptors hot-update without an
 * extension release. `productExtInfo` carries already-structured data when the
 * page side had it cheaply (sniffed API payloads, DOM fallback).
 */
export interface CollectHarvest {
  sourceInfo: SourceInfo;
  /** documentElement.innerHTML of the detail page (or fetched detail HTML). */
  pageContent?: string;
  /** final URL after redirects. */
  afterUrl?: string;
  productExtInfo?: Record<string, unknown>;
  collectedAt: string;
}

/** POST /api/collect/check request/response — dedup marking on list pages. */
export interface CollectCheckRequest {
  items: Array<{ itemUrl: string; itemId?: string }>;
}

export interface CollectCheckResponse {
  ok: boolean;
  /** itemUrls already in the collection box. */
  collected: string[];
}

export * from "./offer1688.js";
