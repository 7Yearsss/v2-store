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
  } = {},
): FakeFetch {
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
      if (query.includes("productSet")) {
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
