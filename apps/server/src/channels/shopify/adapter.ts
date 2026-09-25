import type { Deps } from "../../context.js";
import {
  ChannelError,
  type ChannelAdapter,
  type ListingRow,
  type PublishResult,
  type ShopInfo,
  type StoreRow,
} from "../types.js";
import { shopifyGraphql } from "./client.js";

const SHOP_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop { name currencyCode myshopifyDomain }
  }
`;

const PRODUCT_SET = /* GraphQL */ `
  mutation ProductSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
    productSet(input: $input, identifier: $identifier, synchronous: true) {
      product { id handle onlineStoreUrl }
      userErrors { field message code }
    }
  }
`;

const DEFAULT_OPTION = { name: "Title", value: "Default Title" };

/** Pure mapping listing → ProductSetInput (unit-tested). */
export function toProductSetInput(listing: ListingRow, costRate?: number) {
  const hasOptions = listing.options.length > 0;
  const productOptions = hasOptions
    ? listing.options.map((o, i) => ({
        name: o.name,
        position: i + 1,
        values: o.values.map((name) => ({ name })),
      }))
    : [{ name: DEFAULT_OPTION.name, position: 1, values: [{ name: DEFAULT_OPTION.value }] }];

  const variants = (hasOptions ? listing.variants : listing.variants.slice(0, 1)).map(
    (v, i) => ({
      position: i + 1,
      sku: v.sku || undefined,
      price: v.price.toFixed(2),
      compareAtPrice: v.compareAtPrice ? v.compareAtPrice.toFixed(2) : undefined,
      optionValues: hasOptions
        ? listing.options.map((o, idx) => ({ optionName: o.name, name: v.optionValues[idx] }))
        : [{ optionName: DEFAULT_OPTION.name, name: DEFAULT_OPTION.value }],
      // dropshipping: source stock isn't ours to promise; don't track inventory.
      inventoryItem: {
        tracked: false,
        cost:
          v.costCny && costRate ? (v.costCny * costRate).toFixed(2) : undefined,
      },
    }),
  );

  return {
    title: listing.title,
    descriptionHtml: listing.descriptionHtml,
    vendor: listing.vendor || undefined,
    productType: listing.productType || undefined,
    tags: listing.tags,
    status: "ACTIVE",
    productOptions,
    variants,
    files: listing.images.map((src) => ({
      originalSource: src,
      contentType: "IMAGE",
    })),
  };
}

export function validateForShopify(listing: ListingRow): string | null {
  if (!listing.title.trim()) return "标题不能为空";
  if (listing.title.length > 255) return "标题超过 255 字符";
  if (!listing.variants.length) return "至少需要一个变体";
  if (listing.variants.length > 2048) return "变体超过 2048 个";
  if (listing.options.length > 3) return "选项最多 3 个";
  if (listing.variants.some((v) => !(v.price > 0))) return "存在价格为 0 的变体";
  return null;
}

export const shopifyAdapter: ChannelAdapter = {
  async verify(deps: Deps, store: StoreRow): Promise<ShopInfo> {
    const data = await shopifyGraphql<{
      shop: { name: string; currencyCode: string; myshopifyDomain: string };
    }>(deps, store, SHOP_QUERY);
    return {
      name: data.shop.name,
      currency: data.shop.currencyCode,
      shopDomain: data.shop.myshopifyDomain,
    };
  },

  async publish(deps: Deps, store: StoreRow, listing: ListingRow): Promise<PublishResult> {
    const invalid = validateForShopify(listing);
    if (invalid) throw new ChannelError(invalid);
    const data = await shopifyGraphql<{
      productSet: {
        product: { id: string; handle: string; onlineStoreUrl: string | null } | null;
        userErrors: Array<{ field?: string[]; message: string }>;
      };
    }>(deps, store, PRODUCT_SET, {
      input: toProductSetInput(listing, store.pricing.exchangeRate),
      identifier: listing.remoteId ? { id: listing.remoteId } : undefined,
    });
    const { product, userErrors } = data.productSet;
    if (userErrors.length) {
      throw new ChannelError(
        userErrors
          .map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message))
          .join("; "),
      );
    }
    if (!product) throw new ChannelError("Shopify 未返回商品", false);
    const numericId = product.id.split("/").pop();
    return {
      remoteId: product.id,
      remoteUrl: `https://${store.shopDomain}/admin/products/${numericId}`,
    };
  },
};
