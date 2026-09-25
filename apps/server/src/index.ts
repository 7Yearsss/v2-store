import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDb } from "./db/client.js";
import { env } from "./env.js";
import { jobHandlers } from "./jobs/handlers.js";
import { startWorker } from "./jobs/queue.js";
import { SecretBox } from "./lib/crypto.js";
import type { Deps } from "./context.js";

const handle = await openDb({ url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });

const deps: Deps = {
  db: handle.db,
  secrets: new SecretBox(env.ENCRYPTION_KEY),
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
  },
};

const app = createApp(deps, { log: env.NODE_ENV !== "test" });
const stopWorker = env.RUN_WORKER ? startWorker(deps, jobHandlers) : () => {};

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    `caiji api on http://localhost:${info.port} (db: ${env.DATABASE_URL ? "postgres" : `pglite ${env.PGLITE_DIR}`})`,
  );
});

async function shutdown() {
  stopWorker();
  server.close();
  await handle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
