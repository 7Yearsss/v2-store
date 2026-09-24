import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { CollectedOffer } from "@caiji/shared";
import { ProductStore } from "./store.js";

const app = new Hono();
const store = new ProductStore();

app.use("/api/*", cors());

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/collect", async (c) => {
  const body = (await c.req.json()) as CollectedOffer;
  if (!body?.sourceUrl || !body?.title) {
    return c.json({ ok: false, error: "sourceUrl and title required" }, 400);
  }
  const { product, duplicated } = store.ingest(body);
  return c.json({ ok: true, product, duplicated }, duplicated ? 200 : 201);
});

app.get("/api/products", (c) => c.json(store.list()));

app.get("/api/products/:id", (c) => {
  const p = store.get(c.req.param("id"));
  return p ? c.json(p) : c.notFound();
});

app.patch("/api/products/:id", async (c) => {
  const updated = store.update(c.req.param("id"), await c.req.json());
  return updated ? c.json(updated) : c.notFound();
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`caiji api listening on http://localhost:${port}`);
