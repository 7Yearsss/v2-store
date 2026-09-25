import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AwsClient } from "aws4fetch";

/**
 * Where media bytes live. Local disk for development; an S3-compatible
 * implementation (Cloudflare R2 / Aliyun OSS) slots in behind the same
 * interface for production.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export class LocalDiskStore implements BlobStore {
  private root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error("invalid blob key");
    return p;
  }

  async put(key: string, bytes: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}

/** Cloudflare R2 over its S3-compatible API (SigV4 via aws4fetch). */
export class R2Store implements BlobStore {
  private client: AwsClient;
  private base: string;

  constructor(opts: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.base = `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}`;
  }

  private url(key: string) {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async put(key: string, bytes: Uint8Array, contentType: string) {
    const res = await this.client.fetch(this.url(key), {
      method: "PUT",
      body: bytes as Uint8Array<ArrayBuffer>,
      headers: { "Content-Type": contentType },
    });
    if (!res.ok) throw new Error(`R2 put failed HTTP ${res.status}: ${await res.text()}`);
  }

  async get(key: string) {
    const res = await this.client.fetch(this.url(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 get failed HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** In-memory store for tests. */
export class MemoryStore implements BlobStore {
  blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
  }
  async get(key: string) {
    return this.blobs.get(key) ?? null;
  }
}
