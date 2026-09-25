import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** scrypt$<salt b64>$<hash b64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algo, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * AES-256-GCM for secrets at rest (store access tokens / client secrets).
 * Dev without ENCRYPTION_KEY derives a fixed key — never valid in production
 * (env.ts refuses to boot).
 */
export class SecretBox {
  private key: Buffer;

  constructor(rawKey?: string) {
    if (!rawKey) {
      this.key = createHash("sha256").update("caiji-dev-only-key").digest();
      return;
    }
    const key = /^[0-9a-f]{64}$/i.test(rawKey)
      ? Buffer.from(rawKey, "hex")
      : Buffer.from(rawKey, "base64");
    if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes");
    this.key = key;
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return ["v1", iv, cipher.getAuthTag(), ct]
      .map((p) => (typeof p === "string" ? p : p.toString("base64")))
      .join(".");
  }

  open<T = unknown>(sealed: string): T {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad ciphertext");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ct, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(pt.toString("utf8")) as T;
  }
}
