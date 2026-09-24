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
  aiTitle?: string;
  aiDescription?: string;
  processedAt?: string;
}

export interface CollectResponse {
  ok: boolean;
  product: Product;
  duplicated: boolean;
}
