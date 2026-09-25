import type {
  CategoryCandidate,
  ChannelAttribute,
  RemoteStatus,
} from "@caiji/shared";
import { cacheCategoryNodes, TAXONOMY_VERSION } from "../../lib/category.js";
import { cachedCategoryAttributes } from "../../lib/attributes.js";
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
  opts: { publishStatus?: "active" | "draft"; trackStock?: boolean } = {},
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
      // dropshipping default: source stock isn't ours to promise → untracked
      // (unlimited). trackStock on: track inventory; quantities are written
      // post-publish via inventorySetQuantities (variants get item ids only then).
      inventoryItem: {
        tracked: !!opts.trackStock,
        cost:
          v.costCny && costRate ? (v.costCny * costRate).toFixed(2) : undefined,
        measurement:
          listing.weightKg != null
            ? { weight: { value: listing.weightKg, unit: "KILOGRAMS" } }
            : undefined,
      },
    }),
  );

  return {
    title: listing.title,
    descriptionHtml: listing.descriptionHtml,
    vendor: listing.vendor || undefined,
    productType: listing.productType || undefined,
    tags: listing.tags,
    status: isCreate ? (opts.publishStatus === "draft" ? "DRAFT" : "ACTIVE") : undefined,
    seo: {
      title: listing.title.slice(0, 70),
      description:
        listing.descriptionHtml
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 320) || listing.title.slice(0, 160),
    },
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

const PRODUCT_BIND_DATA = /* GraphQL */ `
  query BindData($id: ID!) {
    product(id: $id) {
      media(first: 250) { nodes { id } }
      variants(first: 250) { nodes { id } }
    }
  }
`;

const FILE_CREATE = /* GraphQL */ `
  mutation DescFiles($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus ... on MediaImage { image { url } } }
      userErrors { field message }
    }
  }
`;

const FILE_POLL = /* GraphQL */ `
  query DescFilePoll($ids: [ID!]!) {
    nodes(ids: $ids) { id ... on MediaImage { fileStatus image { url } } }
  }
`;

interface DescFile {
  id: string;
  fileStatus?: string;
  image?: { url: string } | null;
}

/**
 * staged resourceUrl 是临时地址，不能直接留在描述里（会过期）。
 * 经 fileCreate 转存成 Files 里永久的 cdn URL 后再写进描述 HTML；
 * 处理未就绪的轮询几次，超时退回 staged/原始地址保底。
 */
async function permanentDescUrls(
  deps: Deps,
  store: StoreRow,
  sources: string[],
): Promise<string[]> {
  if (!sources.length) return [];
  try {
    const created = await shopifyGraphql<{
      fileCreate: { files: DescFile[]; userErrors: Array<{ message: string }> };
    }>(deps, store, FILE_CREATE, {
      files: sources.map((originalSource) => ({ contentType: "IMAGE", originalSource })),
    });
    if (created.fileCreate.userErrors.length) {
      return sources; // Shopify 拒绝批量建文件时保底用原地址
    }
    let files = created.fileCreate.files;
    for (let n = 0; n < 6 && files.some((f) => !f?.image?.url); n++) {
      await new Promise((r) => setTimeout(r, 2000));
      const polled = await shopifyGraphql<{ nodes: Array<DescFile | null> }>(
        deps,
        store,
        FILE_POLL,
        { ids: files.map((f) => f.id) },
      );
      files = files.map((f, i) => ({ ...f, ...polled.nodes[i] }));
    }
    return sources.map((src, i) => files[i]?.image?.url ?? src);
  } catch {
    return sources;
  }
}

const VARIANTS_BIND = /* GraphQL */ `
  mutation BindVariantMedia($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

const STOCK_DATA = /* GraphQL */ `
  query StockData($id: ID!) {
    product(id: $id) {
      variants(first: 250) {
        nodes {
          inventoryItem {
            id
            inventoryLevels(first: 10) {
              nodes { location { id } quantities(names: ["available"]) { quantity } }
            }
          }
        }
      }
    }
    locations(first: 10) { nodes { id isActive } }
  }
`;

const LOCATIONS = /* GraphQL */ `
  query Locations {
    locations(first: 50) { nodes { id name isActive } }
  }
`;

const SET_STOCK = /* GraphQL */ `
  mutation SetStock($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { reason }
      userErrors { field message }
    }
  }
`;

/** 货源库存 → Shopify 变体库存：inventoryQuantities 只能对已建好的
 *  inventoryItem 生效，所以发布后按变体顺序精确写入主地点。失败只警告。 */
async function setVariantStock(
  deps: Deps,
  store: StoreRow,
  productId: string,
  listing: ListingRow,
): Promise<string | null> {
  const sent = listing.options.length ? listing.variants : listing.variants.slice(0, 1);
  try {
    const data = await shopifyGraphql<{
      product: {
        variants: {
          nodes: Array<{
            inventoryItem: {
              id: string;
              inventoryLevels: {
                nodes: Array<{ location: { id: string }; quantities: Array<{ quantity: number }> }>;
              };
            };
          }>;
        };
      } | null;
      locations: { nodes: Array<{ id: string; name?: string; isActive: boolean }> };
    }>(deps, store, STOCK_DATA, { id: productId });
    const wanted = store.rules?.inventoryLocationId;
    const configured = wanted ? data.locations.nodes.find((l) => l.id === wanted) : undefined;
    const location = configured ?? data.locations.nodes.find((l) => l.isActive) ?? data.locations.nodes[0];
    if (!location) return "未能写入库存：店铺没有可用仓库地点";
    const locationWarning =
      wanted && !configured
        ? "配置的库存地点已失效，库存写到了第一个可用地点"
        : null;
    // changeFromQuantity 是必填的库存基线：取该地点当前 available，首次发布为 0
    const quantities = sent
      .map((v, i) => {
        const item = data.product?.variants.nodes[i]?.inventoryItem;
        const level = item?.inventoryLevels.nodes.find((l) => l.location.id === location.id);
        return {
          inventoryItemId: item?.id,
          locationId: location.id,
          quantity: Math.max(0, Math.min(Math.floor(v.stock ?? 0), 99999)),
          changeFromQuantity: level?.quantities[0]?.quantity ?? 0,
        };
      })
      .filter(
        (q): q is {
          inventoryItemId: string;
          locationId: string;
          quantity: number;
          changeFromQuantity: number;
        } => !!q.inventoryItemId,
      );
    if (!quantities.length) return "未能写入库存：变体库存项未就绪";
    const res = await shopifyGraphql<{
      inventorySetQuantities: { userErrors: Array<{ message: string }> };
    }>(deps, store, SET_STOCK, {
      input: { reason: "correction", name: "available", quantities },
      key: `stock-${productId}-${Date.now()}`,
    });
    const errs = res.inventorySetQuantities.userErrors;
    const err = errs.length ? `库存写入失败：${errs.map((e) => e.message).join("；")}` : null;
    return [locationWarning, err].filter(Boolean).join("；") || null;
  } catch (e) {
    return `库存写入失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 变体图绑定：规格图已随 files 进 product media，按文件顺序取 mediaId 写回变体。
 *  绑定失败不阻塞发布——商品本体已建好，退化为只有主图。 */
async function bindVariantImages(
  deps: Deps,
  store: StoreRow,
  productId: string,
  listing: ListingRow,
  allImages: string[],
): Promise<string | null> {
  const hasOptions = listing.options.length > 0;
  const sent = hasOptions ? listing.variants : listing.variants.slice(0, 1);
  const wanted = sent
    .map((v, i) => ({ i, fileIndex: v.image ? allImages.indexOf(v.image) : -1 }))
    .filter((w) => w.fileIndex >= 0);
  if (!wanted.length) return null;
  try {
    const data = await shopifyGraphql<{
      product: {
        media: { nodes: Array<{ id: string }> };
        variants: { nodes: Array<{ id: string }> };
      } | null;
    }>(deps, store, PRODUCT_BIND_DATA, { id: productId });
    const mediaNodes = data.product?.media.nodes ?? [];
    const variantNodes = data.product?.variants.nodes ?? [];
    const inputs = wanted
      .map((w) => ({ id: variantNodes[w.i]?.id, mediaId: mediaNodes[w.fileIndex]?.id }))
      .filter((x): x is { id: string; mediaId: string } => !!x.id && !!x.mediaId);
    if (!inputs.length) return `${wanted.length} 个变体图未能绑定（媒体/变体未就绪）`;
    const res = await shopifyGraphql<{
      productVariantsBulkUpdate: { userErrors: Array<{ message: string }> };
    }>(deps, store, VARIANTS_BIND, { productId, variants: inputs });
    const errs = res.productVariantsBulkUpdate.userErrors;
    if (errs.length) return `变体图绑定失败：${errs.map((e) => e.message).join("；")}`;
    return null;
  } catch (e) {
    return `变体图绑定失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

const STD_TEMPLATES = /* GraphQL */ `
  query StdTemplates {
    standardMetafieldDefinitionTemplates(first: 250) {
      nodes { id name namespace key type { name } }
    }
  }
`;

const ENABLE_STD_DEF = /* GraphQL */ `
  mutation EnableStdDef($id: ID!) {
    standardMetafieldDefinitionEnable(id: $id, ownerType: PRODUCT) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

const METAOBJECT_BY_TAXREF = /* GraphQL */ `
  query MetaobjectByTaxref($type: String!, $query: String!) {
    metaobjects(first: 1, type: $type, query: $query) {
      nodes { id }
    }
  }
`;

const METAOBJECT_MINT = /* GraphQL */ `
  mutation MetaobjectMint($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message }
    }
  }
`;

const ATTR_METAFIELDS = /* GraphQL */ `
  mutation AttrMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { namespace key }
      userErrors { field message }
    }
  }
`;

/** 类目标准属性写回 Shopify。
 *  choice 属性值 = Metaobject 引用：按 taxonomy_reference 找到已有
 *  metaobject（Shopify 懒创建，店里只有商家选过的值），没有就铸一个，
 *  然后 metafieldsSet 到 shopify.<key>。attribute → metafield key 没有官方
 *  映射，用 standardMetafieldDefinitionTemplates 按名称匹配。
 *  text/measurement 属性无标准 metafield 写法，跳过。
 *  需要 read_metaobjects/write_metaobjects scope——缺失只警告不阻塞发布。 */
async function writeCategoryAttributes(
  deps: Deps,
  store: StoreRow,
  productId: string,
  listing: ListingRow,
): Promise<string[]> {
  if (!listing.channelAttributes.length || !listing.channelCategoryId) return [];
  try {
    const schema = await cachedCategoryAttributes(
      deps.db,
      deps,
      store,
      listing.channelCategoryId,
    ).catch(() => []);
    const schemaById = new Map(schema.map((a) => [a.id, a]));
    const wanted = listing.channelAttributes
      .map((w) => ({ w, attr: schemaById.get(w.attrId) }))
      .filter((x): x is { w: (typeof listing.channelAttributes)[0]; attr: ChannelAttribute } => !!x.attr);
    if (!wanted.length) return [];

    const tplData = await shopifyGraphql<{
      standardMetafieldDefinitionTemplates: {
        nodes: Array<{ id: string; name: string; namespace: string; key: string }>;
      };
    }>(deps, store, STD_TEMPLATES);
    const templates = tplData.standardMetafieldDefinitionTemplates.nodes.filter(
      (t) => t.namespace === "shopify",
    );

    const metafields: Array<{
      ownerId: string;
      namespace: "shopify";
      key: string;
      type: string;
      value: string;
    }> = [];
    const skipped: string[] = [];
    const enabled = new Set<string>();
    const moCache = new Map<string, string>();

    for (const { w, attr } of wanted) {
      const tpl = templates.find((t) => t.name.toLowerCase() === attr.name.toLowerCase());
      if (!tpl || attr.kind !== "choice") {
        skipped.push(attr.name);
        continue;
      }
      if (!enabled.has(tpl.key)) {
        const en = await shopifyGraphql<{
          standardMetafieldDefinitionEnable: {
            userErrors: Array<{ message: string; code?: string }>;
          };
        }>(deps, store, ENABLE_STD_DEF, { id: tpl.id });
        const errs = en.standardMetafieldDefinitionEnable.userErrors.filter(
          (e) => !/already|taken|exist/i.test(e.message + (e.code ?? "")),
        );
        if (errs.length) {
          skipped.push(`${attr.name}（启用 metafield 失败：${errs[0]!.message}）`);
          continue;
        }
        enabled.add(tpl.key);
      }
      const taxGid = attr.values?.find(
        (v) => v.name.toLowerCase() === w.value.trim().toLowerCase(),
      )?.id;
      if (!taxGid) {
        skipped.push(`${attr.name}=${w.value}（非标准候选值）`);
        continue;
      }
      const moType = `shopify--${tpl.key}`;
      const cacheKey = `${moType}|${taxGid}`;
      let moGid = moCache.get(cacheKey);
      if (!moGid) {
        const found = await shopifyGraphql<{ metaobjects: { nodes: Array<{ id: string }> } }>(
          deps,
          store,
          METAOBJECT_BY_TAXREF,
          { type: moType, query: `fields.taxonomy_reference:"${taxGid}"` },
        );
        moGid = found.metaobjects.nodes[0]?.id;
        if (!moGid) {
          const minted = await shopifyGraphql<{
            metaobjectCreate: {
              metaobject: { id: string } | null;
              userErrors: Array<{ message: string }>;
            };
          }>(deps, store, METAOBJECT_MINT, {
            metaobject: {
              type: moType,
              fields: [{ key: "taxonomy_reference", value: taxGid }],
            },
          });
          if (minted.metaobjectCreate.userErrors.length || !minted.metaobjectCreate.metaobject) {
            skipped.push(
              `${attr.name}=${w.value}（metaobject 创建失败：${minted.metaobjectCreate.userErrors[0]?.message ?? "无返回"}）`,
            );
            continue;
          }
          moGid = minted.metaobjectCreate.metaobject.id;
        }
        moCache.set(cacheKey, moGid);
      }
      metafields.push({
        ownerId: productId,
        namespace: "shopify",
        key: tpl.key,
        type: "list.metaobject_reference",
        value: JSON.stringify([moGid]),
      });
    }

    const warnings: string[] = [];
    if (metafields.length) {
      const res = await shopifyGraphql<{
        metafieldsSet: { userErrors: Array<{ field?: string[]; message: string }> };
      }>(deps, store, ATTR_METAFIELDS, { metafields });
      if (res.metafieldsSet.userErrors.length) {
        warnings.push(
          `类目属性写入失败：${res.metafieldsSet.userErrors.map((e) => e.message).join("；")}`,
        );
      }
    }
    if (skipped.length) warnings.push(`未写入的类目属性：${skipped.join("、")}`);
    return warnings;
  } catch (e) {
    if (e instanceof ChannelError || /access|denied|权限|scope/i.test(String(e))) {
      return [
        `类目属性未写入：${e instanceof Error ? e.message : String(e)}（需要 read_metaobjects / write_metaobjects 权限，给应用版本加 scope 后重新授权店铺）`,
      ];
    }
    return [`类目属性未写入：${e instanceof Error ? e.message : String(e)}`];
  }
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
    // 图片全集 = 主图 + 变体规格图（去重）；变体图也进 product media 再做变体绑定
    const allImages = [...listing.images];
    for (const v of listing.variants) {
      if (v.image && !allImages.includes(v.image)) allImages.push(v.image);
    }
    // 详情图：同一批 staged 上传拿 resourceUrl，再 fileCreate 转永久 cdn URL
    // 写进描述 HTML（商品 media 里没有的位置，描述内嵌图只能用 URL）。
    const media = await prepareShopifyMedia(deps, store, listing.workspaceId, [
      ...allImages,
      ...listing.descImages,
    ]);
    const fileSources = media.sources.slice(0, allImages.length);
    const descSources = media.sources.slice(allImages.length).filter(Boolean);
    const descUrls = await permanentDescUrls(deps, store, descSources);
    const descHtml = descUrls
      .map((src) => `<p><img src="${src}"/></p>`)
      .join("");
    const publishStatus = store.rules?.publishStatus ?? "active";
    const trackStock = !!store.rules?.trackStock;
    const inputListing: ListingRow = descHtml
      ? { ...listing, descriptionHtml: `${listing.descriptionHtml}${descHtml}` }
      : listing;
    const data = await shopifyGraphql<{
      productSet: {
        product: { id: string; handle: string; onlineStoreUrl: string | null } | null;
        userErrors: Array<{ field?: string[]; message: string }>;
      };
    }>(deps, store, PRODUCT_SET, {
      input: toProductSetInput(inputListing, store.pricing.exchangeRate, fileSources, !listing.remoteId, {
        publishStatus,
        trackStock,
      }),
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
    const warnings = await checkShopifyMedia(deps, store, product.id);
    const bindWarning = await bindVariantImages(deps, store, product.id, listing, allImages);
    if (bindWarning) warnings.push(bindWarning);
    if (trackStock) {
      const stockWarning = await setVariantStock(deps, store, product.id, listing);
      if (stockWarning) warnings.push(stockWarning);
    }
    const attrWarnings = await writeCategoryAttributes(deps, store, product.id, listing);
    warnings.push(...attrWarnings);
    if (!listing.remoteId && publishStatus !== "draft") {
      const channelWarning = await publishToOnlineStore(deps, store, product.id);
      if (channelWarning) warnings.push(channelWarning);
    }
    if (media.fallbacks) warnings.unshift(`${media.fallbacks} 张图片未能转存，使用了货源原图链接`);
    const numericId = product.id.split("/").pop();
    return {
      remoteId: product.id,
      remoteUrl: `https://${store.shopDomain}/admin/products/${numericId}`,
      remoteStatus: listing.remoteId ? undefined : publishStatus === "draft" ? "DRAFT" : "ACTIVE",
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

  /** 类目下的标准属性（taxonomy attributes；choice 属性带候选值）。 */
  async categoryAttributes(deps, store, categoryId): Promise<ChannelAttribute[]> {
    const data = await shopifyGraphql<CategoryAttributesData>(
      deps,
      store,
      CATEGORY_ATTRIBUTES,
      { id: categoryId },
    );
    return (data.taxonomyCategory?.attributes.nodes ?? []).map((n) => ({
      id: n.id,
      name: n.name,
      kind:
        n.__typename === "TaxonomyChoiceListAttribute"
          ? "choice"
          : n.__typename === "TaxonomyMeasurementAttribute"
            ? "measurement"
            : "text",
      values: n.values?.nodes,
    }));
  },

  /** 全量同步 Shopify taxonomy 叶子类目进缓存（约 1 万节点，分页拉取）。 */
  async syncCategoryTree(deps, store): Promise<{ count: number }> {
    let after: string | null = null;
    let count = 0;
    do {
      const data: TaxonomyTreePage = await shopifyGraphql<TaxonomyTreePage>(
        deps,
        store,
        TAXONOMY_TREE,
        { after },
      );
      const { nodes, pageInfo } = data.taxonomy.categories;
      const leaves = nodes.filter((n) => n.isLeaf);
      await cacheCategoryNodes(deps.db, "shopify", TAXONOMY_VERSION, leaves);
      count += leaves.length;
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after);
    return { count };
  },

  async listLocations(deps, store) {
    const data = await shopifyGraphql<{
      locations: { nodes: Array<{ id: string; name: string; isActive: boolean }> };
    }>(deps, store, LOCATIONS, {});
    return data.locations.nodes;
  },

  async delistProduct(deps, store, remoteId) {
    const data = await shopifyGraphql<{
      productUpdate: {
        product: { id: string; status: RemoteStatus } | null;
        userErrors: Array<{ message: string }>;
      };
    }>(deps, store, DELIST_PRODUCT, { id: remoteId });
    if (data.productUpdate.userErrors.length) {
      throw new ChannelError(data.productUpdate.userErrors[0].message);
    }
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

const DELIST_PRODUCT = /* GraphQL */ `
  mutation DelistProduct($id: ID!) {
    productUpdate(input: { id: $id, status: DRAFT }) {
      product { id status }
      userErrors { field message }
    }
  }
`;

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

interface CategoryAttributesData {
  taxonomyCategory: {
    attributes: {
      nodes: Array<{
        __typename: string;
        id: string;
        name: string;
        values?: { nodes: Array<{ id: string; name: string }> };
      }>;
    };
  } | null;
}

const CATEGORY_ATTRIBUTES = /* GraphQL */ `
  query CategoryAttributes($id: ID!) {
    taxonomyCategory(id: $id) {
      attributes(first: 50) {
        nodes {
          __typename
          ... on TaxonomyAttribute { id name }
          ... on TaxonomyMeasurementAttribute { id name }
          ... on TaxonomyChoiceListAttribute {
            id
            name
            values(first: 100) { nodes { id name } }
          }
        }
      }
    }
  }
`;

interface TaxonomyTreePage {
  taxonomy: {
    categories: {
      nodes: Array<{ id: string; name: string; fullName: string; isLeaf: boolean }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

const TAXONOMY_TREE = /* GraphQL */ `
  query TaxonomyTree($after: String) {
    taxonomy {
      categories(first: 250, after: $after) {
        nodes { id name fullName isLeaf }
        pageInfo { hasNextPage endCursor }
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
