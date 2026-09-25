import { createHash } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../context.js";
import type { Db } from "../db/client.js";
import { mediaAssets, mediaSources } from "../db/schema.js";
import { HttpError, notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

/**
 * Image pipeline: collected source images are copied into our BlobStore
 * (dedup by content hash) so publishing never depends on the source CDN.
 * The extension uploads bytes it downloaded in the user's browser; a server
 * job fetches whatever is still missing.
 */

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type AssetRow = typeof mediaAssets.$inferSelect;

/** Public path the web app / extension use; auth-checked on read. */
export const mediaUrl = (assetId: string) => `/api/media/${assetId}`;

const MEDIA_URL_RE = /^\/api\/media\/([0-9a-f-]{36})$/;
export const assetIdFromUrl = (url: string) => url.match(MEDIA_URL_RE)?.[1] ?? null;

/** Sniff the real type from magic bytes; CDNs lie about Content-Type. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Store bytes for a source URL (idempotent: same bytes → same asset). */
export async function storeImage(
  deps: Deps,
  workspaceId: string,
  sourceUrl: string,
  bytes: Uint8Array,
): Promise<AssetRow> {
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new HttpError(422, "不是支持的图片格式（jpg/png/webp/gif）");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(422, "图片超过 15MB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  let [asset] = await deps.db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.workspaceId, workspaceId), eq(mediaAssets.sha256, sha256)));
  if (!asset) {
    const storageKey = `${workspaceId}/${sha256.slice(0, 2)}/${sha256}.${EXT[contentType]}`;
    await deps.blobs.put(storageKey, bytes, contentType);
    [asset] = await deps.db
      .insert(mediaAssets)
      .values({ workspaceId, sha256, contentType, byteSize: bytes.byteLength, storageKey })
      .onConflictDoNothing()
      .returning();
    // lost a race with a concurrent upload of the same bytes
    asset ??= (
      await deps.db
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.workspaceId, workspaceId), eq(mediaAssets.sha256, sha256)))
    )[0];
  }
  await deps.db
    .insert(mediaSources)
    .values({ workspaceId, sourceUrl, assetId: asset!.id })
    .onConflictDoUpdate({
      target: [mediaSources.workspaceId, mediaSources.sourceUrl],
      set: { assetId: asset!.id },
    });
  return asset!;
}

/** Server-side download (fallback when the extension didn't upload). */
export async function fetchAndStore(
  deps: Deps,
  workspaceId: string,
  sourceUrl: string,
): Promise<AssetRow> {
  let res: Response;
  try {
    res = await deps.fetch(sourceUrl, {
      headers: { Referer: "https://detail.1688.com/", "User-Agent": "Mozilla/5.0" },
    });
  } catch {
    throw new Error(`图片下载失败：${sourceUrl}`);
  }
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}：${sourceUrl}`);
  return storeImage(deps, workspaceId, sourceUrl, new Uint8Array(await res.arrayBuffer()));
}

/** source URL → asset id, for the URLs we already hold. */
export async function resolveSources(
  db: Db,
  workspaceId: string,
  urls: string[],
): Promise<Map<string, string>> {
  const external = [...new Set(urls.filter((u) => !assetIdFromUrl(u)))];
  if (!external.length) return new Map();
  const rows = await db
    .select({ url: mediaSources.sourceUrl, assetId: mediaSources.assetId })
    .from(mediaSources)
    .where(and(eq(mediaSources.workspaceId, workspaceId), inArray(mediaSources.sourceUrl, external)));
  return new Map(rows.map((r) => [r.url, r.assetId]));
}

/** Rewrite image lists to our media URLs where we hold a copy. */
export async function displayUrls(
  db: Db,
  workspaceId: string,
  lists: string[][],
): Promise<(urls: string[]) => string[]> {
  const map = await resolveSources(db, workspaceId, lists.flat());
  return (urls) => urls.map((u) => (map.has(u) ? mediaUrl(map.get(u)!) : u));
}

/** Load bytes for an image reference (our media URL or a source URL). */
export async function loadImage(
  deps: Deps,
  workspaceId: string,
  url: string,
  opts: { fetchMissing: boolean },
): Promise<{ asset: AssetRow; bytes: Uint8Array } | null> {
  let assetId = assetIdFromUrl(url);
  if (!assetId) assetId = (await resolveSources(deps.db, workspaceId, [url])).get(url) ?? null;
  let asset: AssetRow | undefined;
  if (assetId) {
    [asset] = await deps.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.workspaceId, workspaceId)));
  } else if (opts.fetchMissing && /^https?:\/\//.test(url)) {
    asset = await fetchAndStore(deps, workspaceId, url).catch(() => undefined);
  }
  if (!asset) return null;
  const bytes = await deps.blobs.get(asset.storageKey);
  return bytes ? { asset, bytes } : null;
}

const missingSchema = z.object({ urls: z.array(z.string().url()).max(200) });

export function mediaRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  /** Which of these source URLs do we still need bytes for? */
  r.post("/missing", zValidator("json", missingSchema), async (c) => {
    const { urls } = c.req.valid("json");
    const have = await resolveSources(c.var.deps.db, c.var.auth.workspaceId, urls);
    return c.json({ missing: [...new Set(urls)].filter((u) => !have.has(u)) });
  });

  /** Raw image bytes in the body; ?sourceUrl= identifies the original. */
  r.post("/upload", async (c) => {
    const sourceUrl = c.req.query("sourceUrl");
    if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) {
      throw new HttpError(400, "缺少 sourceUrl");
    }
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_IMAGE_BYTES) throw new HttpError(422, "图片超过 15MB");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.byteLength) throw new HttpError(400, "空文件");
    const asset = await storeImage(c.var.deps, c.var.auth.workspaceId, sourceUrl, bytes);
    return c.json({ id: asset.id, url: mediaUrl(asset.id) }, 201);
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("图片");
    const [asset] = await c.var.deps.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, id), eq(mediaAssets.workspaceId, c.var.auth.workspaceId)));
    const bytes = asset ? await c.var.deps.blobs.get(asset.storageKey) : null;
    if (!asset || !bytes) throw notFound("图片");
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": asset.contentType,
      // content-addressed and immutable
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  return r;
}
