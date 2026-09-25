import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  /** Postgres connection string. Unset → embedded PGlite (dev/test only). */
  DATABASE_URL: z.string().optional(),
  /** PGlite data dir when DATABASE_URL is unset; "memory://" for tests. */
  PGLITE_DIR: z.string().default("./data/pglite"),
  /** Local media storage root (dev). Swap for R2/OSS in production. */
  MEDIA_DIR: z.string().default("./data/media"),
  /** Cloudflare R2 (S3 API). When all four are set, media goes to R2. */
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("v2-store"),
  /** Public origin of the web app (cookies, OAuth redirects). */
  APP_URL: z.string().url().default("http://localhost:5173"),
  /** 32-byte key (hex or base64) for encrypting store credentials at rest. */
  ENCRYPTION_KEY: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  /** Shopify public-app credentials (OAuth install flow). */
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_SCOPES: z
    .string()
    .default("write_products,read_products,read_inventory,write_inventory,read_locations,read_publications,write_publications"),
  SHOPIFY_API_VERSION: z.string().default("2026-07"),
  /** Run the job worker inside the API process. */
  /** How often channel-side product status is pulled back. */
  SYNC_INTERVAL_MINUTES: z.coerce.number().min(1).default(10),
  RUN_WORKER: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof schema>;

export const env: Env = (() => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", z.prettifyError(parsed.error));
    process.exit(1);
  }
  const e = parsed.data;
  if (e.NODE_ENV === "production") {
    if (!e.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
    if (!e.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is required in production");
  }
  return e;
})();
