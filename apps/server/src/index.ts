import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDb } from "./db/client.js";
import { env } from "./env.js";
import {
  enqueueStoreSync,
  jobHandlers,
  RECONCILE_INVENTORY,
} from "./jobs/handlers.js";
import { startWorker } from "./jobs/queue.js";
import { enqueue } from "./jobs/queue.js";
import { jobs, stores } from "./db/schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type BlobStore, LocalDiskStore, R2Store } from "./lib/blobStore.js";
import { SecretBox } from "./lib/crypto.js";
import type { Deps } from "./context.js";

const handle = await openDb({ url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });

const blobs: BlobStore =
  env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
    ? new R2Store({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
      })
    : new LocalDiskStore(env.MEDIA_DIR);

const deps: Deps = {
  db: handle.db,
  secrets: new SecretBox(env.ENCRYPTION_KEY),
  blobs,
  fetch: globalThis.fetch,
  config: {
    appUrl: env.APP_URL,
    sessionTtlDays: env.SESSION_TTL_DAYS,
    secureCookies: env.APP_URL.startsWith("https://"),
    shopify: {
      apiKey: env.SHOPIFY_API_KEY,
      apiSecret: env.SHOPIFY_API_SECRET,
      scopes: env.SHOPIFY_SCOPES,
      apiVersion: env.SHOPIFY_API_VERSION,
    },
    ...(env.AI_BASE_URL && env.AI_API_KEY
      ? { ai: { baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL, imageModel: env.AI_IMAGE_MODEL } }
      : {}),
  },
};

const app = createApp(deps, { log: env.NODE_ENV !== "test" });
const stopWorker = env.RUN_WORKER ? startWorker(deps, jobHandlers) : () => {};

/** Pull channel-side product status for every active store periodically. */
async function scheduleStoreSyncs() {
  const rows = await deps.db
    .select({ id: stores.id, workspaceId: stores.workspaceId })
    .from(stores)
    .where(eq(stores.status, "active"));
  for (const s of rows) await enqueueStoreSync(deps.db, s.id, s.workspaceId);
}
const syncTimer = env.RUN_WORKER
  ? setInterval(() => scheduleStoreSyncs().catch((e) => console.error("[sync]", e)), env.SYNC_INTERVAL_MINUTES * 60_000)
  : undefined;

/** 仓储 L1 每日兜底：给每个开启了货源监控的店铺入队 inventory.reconcile，
 *  job 内再逐刊登按 inventory 策略重算推送库存（防重扫漏报）。 */
async function scheduleInventoryReconcile() {
  const rows = await deps.db
    .select({ id: stores.id, workspaceId: stores.workspaceId })
    .from(stores)
    .where(eq(stores.status, "active"));
  for (const s of rows) {
    const pending = await deps.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, RECONCILE_INVENTORY),
          inArray(jobs.status, ["queued", "running"]),
          sql`${jobs.payload}->>'storeId' = ${s.id}`,
        ),
      )
      .limit(1);
    if (!pending.length) {
      await enqueue(deps.db, RECONCILE_INVENTORY, { storeId: s.id }, { workspaceId: s.workspaceId, maxAttempts: 1 });
    }
  }
}
const reconcileTimer = env.RUN_WORKER
  ? setInterval(() => scheduleInventoryReconcile().catch((e) => console.error("[reconcile]", e)), 24 * 3600_000)
  : undefined;

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    `caiji api on http://localhost:${info.port} (db: ${env.DATABASE_URL ? "postgres" : `pglite ${env.PGLITE_DIR}`}, media: ${blobs instanceof R2Store ? `r2 ${env.R2_BUCKET}` : `disk ${env.MEDIA_DIR}`})`,
  );
});

async function shutdown() {
  stopWorker();
  clearInterval(syncTimer);
  clearInterval(reconcileTimer);
  server.close();
  await handle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
