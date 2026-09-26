import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDb } from "./db/client.js";
import { env } from "./env.js";
import type { Deps } from "./context.js";
import { seedDemo } from "./services/imports.js";
import { startPublishRunner } from "./services/publish.js";

const handle = await openDb({ url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });

const deps: Deps = {
  db: handle.db,
  config: {
    ai:
      env.AI_BASE_URL && env.AI_API_KEY
        ? { baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL }
        : undefined,
    mock: { publishDelayMs: env.PUBLISH_DELAY_MS },
  },
  actor: "user",
};

await seedDemo(deps);
const stopRunner = startPublishRunner(deps);

const app = createApp(deps);
const server = serve({ fetch: app.fetch, port: env.PORT });
console.log(`[studio] api on :${env.PORT}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopRunner();
    server.close();
    await handle.close();
    process.exit(0);
  });
}
