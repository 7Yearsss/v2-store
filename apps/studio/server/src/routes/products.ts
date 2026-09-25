import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { products } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { ensureDraft, getProduct, toProduct } from "../services/draft.js";
import { importCsv, productFromUrl } from "../services/imports.js";

const variantSchema = z.object({
  sku: z.string().max(128),
  options: z.record(z.string().max(128), z.string().max(256)).default({}),
  price: z.number().nonnegative(),
  stock: z.number().int().nonnegative().default(0),
  upc: z.string().max(64).nullable().default(null),
});

const createSchema = z.object({
  title: z.string().min(1).max(500),
  images: z.array(z.string().max(2048)).max(20).default([]),
  variants: z.array(variantSchema).max(200).default([]),
  sourceCategory: z.string().max(300).nullable().default(null),
});

export const productsRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { db } = c.get("deps");
    const q = c.req.query("q");
    const rows = await db.query.products.findMany({
      where: q ? like(products.title, `%${q}%`) : undefined,
      orderBy: desc(products.createdAt),
      limit: 500,
    });
    return c.json({ items: rows.map(toProduct), total: rows.length });
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const { db, actor } = c.get("deps");
    const [row] = await db
      .insert(products)
      .values({ source: "manual", ...c.req.valid("json") })
      .returning();
    await ensureDraft(db, row.id);
    await audit(db, actor, {
      action: "product.create",
      entityType: "product",
      entityId: row.id,
      payload: { source: "manual", title: row.title },
    });
    return c.json(toProduct(row), 201);
  })
  .post(
    "/import",
    zValidator("json", z.object({ csv: z.string().min(1).max(512 * 1024) })),
    async (c) => {
    const { db, actor } = c.get("deps");
      const result = await importCsv(c.get("deps"), c.req.valid("json").csv);
      await audit(db, actor, {
        action: "product.import",
        entityType: "product",
        entityId: result.created[0]?.id ?? "00000000-0000-0000-0000-000000000000",
        payload: { created: result.created.length, errors: result.errors.length },
      });
      return c.json(result, 201);
    },
  )
  .post(
    "/from-url",
    zValidator("json", z.object({ url: z.string().url() })),
    async (c) => {
      const { db, actor } = c.get("deps");
      const p = await productFromUrl(c.get("deps"), c.req.valid("json").url);
      await audit(db, actor, {
        action: "product.from_url",
        entityType: "product",
        entityId: p.id,
        payload: { url: c.req.valid("json").url },
      });
      return c.json(p, 201);
    },
  )
  .get("/:id", async (c) => {
    const { db } = c.get("deps");
    return c.json(toProduct(await getProduct(db, c.req.param("id"))));
  })
  .delete("/:id", async (c) => {
    const { db } = c.get("deps");
    const [row] = await db
      .delete(products)
      .where(eq(products.id, c.req.param("id")))
      .returning();
    if (!row) throw notFound("商品");
    return c.body(null, 204);
  });
