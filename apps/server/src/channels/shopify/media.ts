import type { Deps } from "../../context.js";
import { loadImage } from "../../modules/media.js";
import { ChannelError, type StoreRow } from "../types.js";
import { shopifyGraphql } from "./client.js";

const STAGED_UPLOADS = /* GraphQL */ `
  mutation StagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const PRODUCT_MEDIA = /* GraphQL */ `
  query ProductMedia($id: ID!) {
    product(id: $id) {
      media(first: 100) {
        nodes { status mediaErrors { message } }
      }
    }
  }
`;

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

/**
 * Turn listing image refs into productSet `originalSource`s. Images we hold
 * (or can fetch now) are uploaded to Shopify's staged storage, so publishing
 * never depends on the source CDN being reachable from Shopify. Images we
 * can't obtain fall back to their source URL.
 */
export async function prepareShopifyMedia(
  deps: Deps,
  store: StoreRow,
  workspaceId: string,
  images: string[],
): Promise<{ sources: string[]; fallbacks: number }> {
  const loaded = await Promise.all(
    images.map((url) => loadImage(deps, workspaceId, url, { fetchMissing: true })),
  );
  const toUpload = loaded
    .map((l, i) => (l ? { i, ...l } : null))
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const sources = [...images];
  if (toUpload.length) {
    const data = await shopifyGraphql<{
      stagedUploadsCreate: {
        stagedTargets: StagedTarget[];
        userErrors: Array<{ message: string }>;
      };
    }>(deps, store, STAGED_UPLOADS, {
      input: toUpload.map(({ asset }) => ({
        resource: "PRODUCT_IMAGE",
        filename: asset.storageKey.split("/").pop(),
        mimeType: asset.contentType,
        httpMethod: "POST",
      })),
    });
    const { stagedTargets, userErrors } = data.stagedUploadsCreate;
    if (userErrors.length) throw new ChannelError(userErrors.map((e) => e.message).join("; "));

    await Promise.all(
      toUpload.map(async ({ i, asset, bytes }, k) => {
        const target = stagedTargets[k]!;
        const form = new FormData();
        for (const p of target.parameters) form.append(p.name, p.value);
        // the file part must come last
        form.append(
          "file",
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: asset.contentType }),
          asset.storageKey.split("/").pop(),
        );
        const res = await deps.fetch(target.url, { method: "POST", body: form });
        if (!res.ok) throw new ChannelError(`图片上传到 Shopify 失败 HTTP ${res.status}`, false);
        sources[i] = target.resourceUrl;
      }),
    );
  }
  return { sources, fallbacks: images.length - toUpload.length };
}

/**
 * Shopify processes media asynchronously after productSet. Poll briefly and
 * report failures so a product never silently ends up without images.
 */
export async function checkShopifyMedia(
  deps: Deps,
  store: StoreRow,
  productId: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<string[]> {
  const attempts = opts.attempts ?? 6;
  for (let n = 0; n < attempts; n++) {
    const data = await shopifyGraphql<{
      product: { media: { nodes: Array<{ status: string; mediaErrors: Array<{ message: string }> }> } } | null;
    }>(deps, store, PRODUCT_MEDIA, { id: productId });
    const nodes = data.product?.media.nodes ?? [];
    const pending = nodes.filter((m) => m.status === "UPLOADED" || m.status === "PROCESSING");
    if (!pending.length || n === attempts - 1) {
      const failed = nodes.filter((m) => m.status === "FAILED");
      return failed.length
        ? [`${failed.length} 张图片处理失败：${failed[0]!.mediaErrors[0]?.message ?? "未知原因"}`]
        : [];
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
  }
  return [];
}
