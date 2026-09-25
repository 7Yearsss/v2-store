import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { shopifyAppRoutes } from "./channels/shopify/oauth.js";
import type { AppEnv, Deps } from "./context.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./modules/auth.js";
import { collectRoutes } from "./modules/collect.js";
import { listingRoutes } from "./modules/listings.js";
import { mediaRoutes } from "./modules/media.js";
import { sourceItemRoutes } from "./modules/sourceItems.js";
import { storeRoutes } from "./modules/stores.js";

export function createApp(deps: Deps, opts: { log?: boolean } = {}) {
  const app = new Hono<AppEnv>();

  if (opts.log) app.use(logger());
  app.use(async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/auth", authRoutes());
  app.route("/api/collect", collectRoutes());
  app.route("/api/source-items", sourceItemRoutes());
  app.route("/api/stores", storeRoutes());
  app.route("/api/listings", listingRoutes());
  app.route("/api/media", mediaRoutes());
  app.route("/api/shopify", shopifyAppRoutes());

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error(err);
    return c.json({ error: "服务器内部错误" }, 500);
  });

  return app;
}
