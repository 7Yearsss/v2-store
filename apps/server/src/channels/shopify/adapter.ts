import type { CategoryCandidate, RemoteStatus } from "@caiji/shared";
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
import { checkShopifyMedia, prepareShopifyMedia } from "./media.js";

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
export function toProductSetInput(
  listing: ListingRow,
  costRate?: number,
  /** originalSource per image (staged-upload URLs); defaults to listing.images */
  fileSources: string[] = listing.images,
  /** status is set only when creating — later syncs must not override what
   *  the merchant chose in Shopify (e.g. switched back to draft) */
  isCreate = !listing.remoteId,
) {
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
    status: isCreate ? "ACTIVE" : undefined,
    category: listing.channelCategoryId || undefined,
    productOptions,
    variants,
    files: fileSources.map((src) => ({
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
    const media = await prepareShopifyMedia(deps, store, listing.workspaceId, listing.images);
    const data = await shopifyGraphql<{
      productSet: {
        product: { id: string; handle: string; onlineStoreUrl: string | null } | null;
        userErrors: Array<{ field?: string[]; message: string }>;
      };
    }>(deps, store, PRODUCT_SET, {
      input: toProductSetInput(listing, store.pricing.exchangeRate, media.sources),
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
    const warnings = await checkShopifyMedia(deps, store, product.id);
    if (!listing.remoteId) {
      const channelWarning = await publishToOnlineStore(deps, store, product.id);
      if (channelWarning) warnings.push(channelWarning);
    }
    if (media.fallbacks) warnings.unshift(`${media.fallbacks} 张图片未能转存，使用了货源原图链接`);
    return {
      remoteId: product.id,
      remoteUrl: `https://${store.shopDomain}/admin/products/${numericId}`,
      remoteStatus: listing.remoteId ? undefined : "ACTIVE",
      warnings,
    };
  },

  async searchCategories(deps, store, query): Promise<CategoryCandidate[]> {
    const data = await shopifyGraphql<{
      taxonomy: {
        categories: {
          nodes: Array<{ id: string; name: string; fullName: string }>;
        };
      };
    }>(deps, store, TAXONOMY_SEARCH, { query });
    return data.taxonomy.categories.nodes;
  },

  async fetchStatuses(deps, store, remoteIds) {
    const out = new Map<string, RemoteStatus>();
    for (let i = 0; i < remoteIds.length; i += 100) {
      const ids = remoteIds.slice(i, i + 100);
      const data = await shopifyGraphql<{
        nodes: Array<{ id: string; status: RemoteStatus } | null>;
      }>(deps, store, PRODUCT_STATUSES, { ids });
      data.nodes.forEach((n, k) => out.set(ids[k]!, n?.status ?? "DELETED"));
    }
    return out;
  },
};

const PUBLICATIONS = /* GraphQL */ `
  query Publications {
    publications(first: 50) { nodes { id supportsFuturePublishing } }
  }
`;

const PUBLISHABLE_PUBLISH = /* GraphQL */ `
  mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

const TAXONOMY_SEARCH = /* GraphQL */ `
  query TaxonomySearch($query: String!) {
    taxonomy {
      categories(first: 8, search: $query) {
        nodes { id name fullName }
      }
    }
  }
`;

const PRODUCT_STATUSES = /* GraphQL */ `
  query ProductStatuses($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { id status } }
  }
`;

/**
 * API-created products aren't on any sales channel; put new ones on the
 * Online Store (the only publication that supports future publishing).
 * Returns a warning instead of failing — the product itself was created.
 */
async function publishToOnlineStore(
  deps: Deps,
  store: StoreRow,
  productId: string,
): Promise<string | null> {
  try {
    const { publications } = await shopifyGraphql<{
      publications: { nodes: Array<{ id: string; supportsFuturePublishing: boolean }> };
    }>(deps, store, PUBLICATIONS);
    const online = publications.nodes.find((p) => p.supportsFuturePublishing);
    if (!online) return "店铺没有在线商店渠道，商品未挂到前台";
    const { publishablePublish } = await shopifyGraphql<{
      publishablePublish: { userErrors: Array<{ message: string }> };
    }>(deps, store, PUBLISHABLE_PUBLISH, { id: productId, input: [{ publicationId: online.id }] });
    return publishablePublish.userErrors.length
      ? `未能挂到在线商店：${publishablePublish.userErrors[0]!.message}`
      : null;
  } catch (e) {
    if (!(e instanceof ChannelError)) throw e;
    return /access|denied|权限|scope/i.test(e.message)
      ? "未能挂到在线商店：应用缺少 read_publications / write_publications 权限，请在店铺后台更新应用授权"
      : `未能挂到在线商店：${e.message}`;
  }
}
