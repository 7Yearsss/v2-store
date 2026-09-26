import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { shopifyAppRoutes } from "./channels/shopify/oauth.js";
import type { AppEnv, Deps } from "./context.js";
import { HttpError } from "./lib/errors.js";
import { attributeMappingRoutes } from "./modules/attributeMappings.js";
import { authRoutes } from "./modules/auth.js";
import { categoryMappingRoutes } from "./modules/categoryMappings.js";
import { termMappingRoutes } from "./modules/termMappings.js";
import { collectRoutes } from "./modules/collect.js";
import { freightForwarderRoutes } from "./modules/freightForwarders.js";
import { jobRoutes } from "./modules/jobs.js";
import { listingRoutes } from "./modules/listings.js";
import { mediaRoutes } from "./modules/media.js";
import { orderRoutes } from "./modules/orders.js";
import { overviewRoutes } from "./modules/overview.js";
import { purchaseOrderRoutes } from "./modules/purchaseOrders.js";
import { publishRoutes } from "./modules/publish.js";
import { sourceChangeRoutes } from "./modules/sourceChanges.js";
import { discoveryRoutes, selectionPlanRoutes } from "./modules/selection.js";import { sourceItemRoutes } from "./modules/sourceItems.js";
import { storeRoutes } from "./modules/stores.js";
import { templateRoutes } from "./modules/templates.js";

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
  app.route("/api/source-changes", sourceChangeRoutes());
  app.route("/api/freight-forwarders", freightForwarderRoutes());
  app.route("/api/overview", overviewRoutes());
  app.route("/api/jobs", jobRoutes());
  app.route("/api/publish", publishRoutes());
  app.route("/api/category-mappings", categoryMappingRoutes());
  app.route("/api/term-mappings", termMappingRoutes());
  app.route("/api/templates", templateRoutes());
  app.route("/api/selection-plans", selectionPlanRoutes());
  app.route("/api/discovery", discoveryRoutes());
  app.route("/api/attribute-mappings", attributeMappingRoutes());
  app.route("/api/media", mediaRoutes());
  app.route("/api/orders", orderRoutes());
  app.route("/api/purchase-orders", purchaseOrderRoutes());
  app.route("/api/freight-forwarders", freightForwarderRoutes());
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
