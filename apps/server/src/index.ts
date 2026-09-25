import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type {
  CollectedOffer,
  CollectHarvest,
} from "@caiji/shared";
import { findInitData, normalizeOffer } from "@caiji/shared";
import { ProductStore } from "./store.js";

const app = new Hono();
const store = new ProductStore();

app.use("/api/*", cors());

app.get("/api/health", (c) => c.json({ ok: true }));

/** Harvest contract: extension ships pageContent + URL tokens; all field
 * extraction happens here so site adaptors hot-update without releases.
 * Falls back to productExtInfo.offer when the page side already parsed
 * (sniffed API payloads / DOM fallback), then to legacy CollectedOffer. */
function harvestToOffer(body: CollectHarvest): CollectedOffer | null {
  const { sourceInfo, pageContent, productExtInfo, afterUrl } = body ?? {};
  if (!sourceInfo?.itemUrl) return null;

  const initData =
    productExtInfo?.initData ?? (pageContent ? findInitData(pageContent) : null);
  if (initData) {
    return {
      ...normalizeOffer(initData, sourceInfo.itemId, sourceInfo.itemUrl),
      sourceUrl: sourceInfo.itemUrl,
      collectedAt: body.collectedAt ?? new Date().toISOString(),
    };
  }

  const offer = productExtInfo?.offer as CollectedOffer | undefined;
  if (offer?.title) {
    return {
      ...offer,
      sourceUrl: offer.sourceUrl || sourceInfo.itemUrl,
      collectedAt: body.collectedAt ?? offer.collectedAt,
    };
  }

  if (afterUrl && afterUrl !== sourceInfo.itemUrl) {
    return null; // redirected (login wall) — nothing parseable
  }
  return null;
}

app.post("/api/collect", async (c) => {
  const body = await c.req.json();

  // harvest contract path
  if (body?.sourceInfo?.itemUrl) {
    const offer = harvestToOffer(body as CollectHarvest);
    if (!offer?.title) {
      return c.json(
        { ok: false, error: "pageContent 未解析出商品数据", antiCode: "rowDataInvalid" },
        422,
      );
    }
    const { product, duplicated } = store.ingest(offer);
    return c.json({ ok: true, product, duplicated }, duplicated ? 200 : 201);
  }

  // legacy path: already-normalized offer (web paste-link import, tests)
  const offer = body as CollectedOffer;
  if (!offer?.sourceUrl || !offer?.title) {
    return c.json({ ok: false, error: "sourceUrl and title required" }, 400);
  }
  const { product, duplicated } = store.ingest(offer);
  return c.json({ ok: true, product, duplicated }, duplicated ? 200 : 201);
});

/** Dedup marking — list pages batch-check which items are already collected. */
app.post("/api/collect/check", async (c) => {
  const body = await c.req.json();
  const items: Array<{ itemUrl?: string; itemId?: string }> = body?.items ?? [];
  const collected = items
    .filter((i) => store.hasCollected(i.itemUrl, i.itemId))
    .map((i) => i.itemUrl)
    .filter(Boolean);
  return c.json({ ok: true, collected });
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
