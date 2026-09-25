import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, Deps } from "./context.js";
import { HttpError } from "./lib/errors.js";
import { shopsRoutes } from "./routes/shops.js";
import { productsRoutes } from "./routes/products.js";
import { draftRoutes } from "./routes/draft.js";
import { publishRoutes } from "./routes/publish.js";
import { metaRoutes } from "./routes/meta.js";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", cors());
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as never);
    }
    console.error(err);
    return c.json({ error: "服务器错误" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  const api = new Hono<AppEnv>()
    .route("/shops", shopsRoutes)
    .route("/products", productsRoutes)
    // /api/products/:id/draft + /ai
    .route("/products/:id/draft", draftRoutes)
    .route("/publish", publishRoutes)
    .route("/meta", metaRoutes);

  app.route("/api", api);
  return app;
}
