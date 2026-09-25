import { type FakeFetch, json } from "./helpers.js";

/** Minimal fake Shopify Admin API. */
export function fakeShopify(
  opts: {
    productSetErrors?: Array<{ field?: string[]; message: string }>;
    mediaStatus?: "READY" | "FAILED";
    /** bytes served for source image URLs (server-side fetch fallback) */
    sourceImages?: Record<string, Uint8Array>;
    /** remote id → status for the sync query; null = product deleted */
    remoteStatuses?: Record<string, string | null>;
    /** simulate an app installed without publication scopes */
    noPublicationScope?: boolean;
    /** taxonomy search results keyed by the search query substring, else a default set */
    taxonomy?: Record<string, Array<{ id: string; name: string; fullName: string }>>;
    /** taxonomyCategory(id) → attributes list for the CategoryAttributes query */
    categoryAttributes?: Array<{
      __typename: string;
      id: string;
      name: string;
      values?: { nodes: Array<{ id: string; name: string }> };
    }>;
    /** records metafieldsSet input; tests may declare a narrower element type */
    capturedMetafields?: Array<Record<string, unknown>>;
    /** taxonomy_reference gid → pre-existing metaobject gid (skip minting) */
    metaobjectsByTaxref?: Record<string, string>;
    /** records the last productSet input (variants/files/….) for assertions */
    capturedProductSet?: Array<Record<string, unknown>>;
    /** override the locations returned by the StockData/Locations queries */
    locations?: Array<{ id: string; name?: string; isActive: boolean }>;
    /** records inventorySetQuantities input.quantities for assertions */
    capturedStock?: Array<Array<Record<string, unknown>>>;
    /** records product ids passed to DelistProduct */
    capturedDelist?: string[];
  } = {},
): FakeFetch {
  let filesCount = 0;
  let variantsCount = 0;
  let metaobjectCount = 0;
  return (url, init) => {
    const img = opts.sourceImages?.[url];
    if (img) return new Response(img as Uint8Array<ArrayBuffer>, { status: 200 });
    if (url.startsWith("https://staged.example/")) {
      return new Response(null, { status: 201 });
    }
    if (url.endsWith("/admin/oauth/access_token")) {
      return json({ access_token: "shpat_cc", expires_in: 86399 });
    }
    if (url.includes("/graphql.json")) {
      const headers = init.headers as Record<string, string>;
      if (!headers["X-Shopify-Access-Token"]?.startsWith("shpat_")) return json({}, 401);
      const { query, variables } = JSON.parse(String(init.body));
      if (query.includes("CategoryAttributes")) {
        return json({
          data: {
            taxonomyCategory: {
              attributes: {
                nodes: opts.categoryAttributes ?? [
                  {
                    __typename: "TaxonomyChoiceListAttribute",
                    id: "gid://shopify/TaxonomyChoiceListAttribute/material",
                    name: "Material",
                    values: {
                      nodes: [
                        { id: "gid://shopify/TaxonomyValue/1", name: "Cotton" },
                        { id: "gid://shopify/TaxonomyValue/2", name: "Polyester" },
                      ],
                    },
                  },
                  {
                    __typename: "TaxonomyAttribute",
                    id: "gid://shopify/TaxonomyAttribute/pattern",
                    name: "Pattern",
                  },
                ],
              },
            },
          },
        });
      }
      if (query.includes("TaxonomyTree")) {
        const nodes = (
          opts.taxonomy?.["*"] ?? [
            { id: "gid://shopify/TaxonomyCategory/c1", name: "Coats", fullName: "Apparel > Outerwear > Coats" },
            { id: "gid://shopify/TaxonomyCategory/c2", name: "Jackets", fullName: "Apparel > Outerwear > Jackets" },
            { id: "gid://shopify/TaxonomyCategory/c3", name: "Hoodies", fullName: "Apparel > Tops > Hoodies" },
          ]
        ).map((n) => ({ ...n, isLeaf: true }));
        return json({
          data: {
            taxonomy: {
              categories: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        });
      }
      if (query.includes("TaxonomySearch")) {
        const nodes =
          opts.taxonomy?.[variables.query] ??
          opts.taxonomy?.["*"] ?? [
            { id: "gid://shopify/TaxonomyCategory/c1", name: "Coats", fullName: "Apparel > Outerwear > Coats" },
            { id: "gid://shopify/TaxonomyCategory/c2", name: "Jackets", fullName: "Apparel > Outerwear > Jackets" },
            { id: "gid://shopify/TaxonomyCategory/c3", name: "Hoodies", fullName: "Apparel > Tops > Hoodies" },
          ];
        return json({ data: { taxonomy: { categories: { nodes } } } });
      }
      if (query.includes("stagedUploadsCreate")) {
        return json({
          data: {
            stagedUploadsCreate: {
              stagedTargets: variables.input.map((_: unknown, i: number) => ({
                url: `https://staged.example/upload/${i}`,
                resourceUrl: `https://staged.example/resource/${i}`,
                parameters: [{ name: "key", value: `k${i}` }],
              })),
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("ProductMedia")) {
        return json({
          data: {
            product: {
              media: {
                nodes: [
                  {
                    status: opts.mediaStatus ?? "READY",
                    mediaErrors: opts.mediaStatus === "FAILED" ? [{ message: "Image could not be downloaded" }] : [],
                  },
                ],
              },
            },
          },
        });
      }
      if (query.includes("query Publications")) {
        if (opts.noPublicationScope) {
          return json({ errors: [{ message: "Access denied for publications field." }] });
        }
        return json({
          data: {
            publications: {
              nodes: [
                { id: "gid://shopify/Publication/pos", supportsFuturePublishing: false },
                { id: "gid://shopify/Publication/online", supportsFuturePublishing: true },
              ],
            },
          },
        });
      }
      if (query.includes("publishablePublish")) {
        return json({ data: { publishablePublish: { userErrors: [] } } });
      }
      if (query.includes("DelistProduct")) {
        opts.capturedDelist?.push(variables.id);
        if (opts.remoteStatuses && variables.id in opts.remoteStatuses && !opts.remoteStatuses[variables.id]) {
          return json({
            data: { productUpdate: { product: null, userErrors: [{ message: "Product not found" }] } },
          });
        }
        return json({
          data: { productUpdate: { product: { id: variables.id, status: "DRAFT" }, userErrors: [] } },
        });
      }
      if (query.includes("ProductStatuses")) {
        return json({
          data: {
            nodes: variables.ids.map((id: string) =>
              opts.remoteStatuses && id in opts.remoteStatuses
                ? opts.remoteStatuses[id] && { id, status: opts.remoteStatuses[id] }
                : { id, status: "ACTIVE" },
            ),
          },
        });
      }
      if (query.includes("ShopInfo")) {
        return json({
          data: { shop: { name: "Demo", currencyCode: "USD", myshopifyDomain: "demo.myshopify.com" } },
        });
      }
      if (query.includes("DescFiles")) {
        return json({
          data: {
            fileCreate: {
              files: variables.files.map((_: unknown, i: number) => ({
                id: `gid://shopify/MediaImage/f${i}`,
                fileStatus: "READY",
                image: { url: `https://cdn.example/desc/f${i}.jpg` },
              })),
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("DescFilePoll")) {
        return json({
          data: {
            nodes: variables.ids.map((id: string) => ({
              id,
              fileStatus: "READY",
              image: { url: `https://cdn.example/desc/${id.split("/").pop()}.jpg` },
            })),
          },
        });
      }
      if (query.includes("StockData")) {
        return json({
          data: {
            product: {
              variants: {
                nodes: Array.from({ length: variantsCount }, (_, i) => ({
                  inventoryItem: {
                    id: `gid://shopify/InventoryItem/i${i}`,
                    inventoryLevels: { nodes: [] },
                  },
                })),
              },
            },
            locations: {
              nodes: opts.locations ?? [{ id: "gid://shopify/Location/l1", isActive: true }],
            },
          },
        });
      }
      if (query.includes("Locations")) {
        return json({
          data: {
            locations: {
              nodes: opts.locations ?? [{ id: "gid://shopify/Location/l1", name: "主地点", isActive: true }],
            },
          },
        });
      }
      if (query.includes("inventorySetQuantities")) {
        if (opts.capturedStock) opts.capturedStock.push(variables.input?.quantities ?? []);
        return json({
          data: {
            inventorySetQuantities: {
              inventoryAdjustmentGroup: { reason: "correction" },
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("BindData")) {
        return json({
          data: {
            product: {
              media: {
                nodes: Array.from({ length: filesCount }, (_, i) => ({
                  id: `gid://shopify/Media/m${i}`,
                })),
              },
              variants: {
                nodes: Array.from({ length: variantsCount }, (_, i) => ({
                  id: `gid://shopify/ProductVariant/v${i}`,
                })),
              },
            },
          },
        });
      }
      if (query.includes("productVariantsBulkUpdate")) {
        return json({
          data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } },
        });
      }
      if (query.includes("StdTemplates")) {
        return json({
          data: {
            standardMetafieldDefinitionTemplates: {
              nodes: [
                {
                  id: "gid://shopify/StandardMetafieldDefinitionTemplate/material",
                  name: "Material",
                  namespace: "shopify",
                  key: "material",
                  type: { name: "list.metaobject_reference" },
                },
              ],
            },
          },
        });
      }
      if (query.includes("EnableStdDef")) {
        return json({
          data: {
            standardMetafieldDefinitionEnable: {
              createdDefinition: { id: "gid://shopify/MetafieldDefinition/md1" },
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("MetaobjectByTaxref")) {
        const taxGid = String(variables.query.match(/taxonomy_reference:\"([^"]+)/)?.[1] ?? "");
        const mo = opts.metaobjectsByTaxref?.[taxGid];
        return json({ data: { metaobjects: { nodes: mo ? [{ id: mo }] : [] } } });
      }
      if (query.includes("MetaobjectMint")) {
        return json({
          data: {
            metaobjectCreate: {
              metaobject: { id: `gid://shopify/Metaobject/mo${++metaobjectCount}` },
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("AttrMetafields")) {
        opts.capturedMetafields?.push(...variables.metafields);
        return json({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
      }
      if (query.includes("productSet")) {
        filesCount = variables.input?.files?.length ?? 0;
        if (opts.capturedProductSet) opts.capturedProductSet.push(variables.input);
        variantsCount = variables.input?.variants?.length ?? 0;
        return json({
          data: {
            productSet: opts.productSetErrors?.length
              ? { product: null, userErrors: opts.productSetErrors }
              : {
                  product: { id: "gid://shopify/Product/42", handle: "t", onlineStoreUrl: null },
                  userErrors: [],
                },
          },
        });
      }
    }
    return json({ errors: [{ message: `unhandled ${url}` }] }, 404);
  };
}
