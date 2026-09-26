import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Shop } from "@studio/shared";
import type { AppEnv } from "../context.js";
import { shops, type ShopRow } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";

function toShop(r: ShopRow): Shop {
  return {
    id: r.id,
    platform: r.platform,
    site: r.site,
    name: r.name,
    authStatus: r.authStatus,
    externalId: r.externalId,
    createdAt: r.createdAt.toISOString(),
  };
}

const createSchema = z.object({
  platform: z.enum(["shopee", "tiktok"]),
  site: z.string().min(1),
  name: z.string().min(1),
  externalId: z.string().optional(),
});

export const shopsRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { db } = c.get("deps");
    const rows = await db.query.shops.findMany({
      where: isNull(shops.archivedAt),
      orderBy: desc(shops.createdAt),
    });
    return c.json({ items: rows.map(toShop), total: rows.length });
  })
  // mock 授权：建店即"已授权"；真实 OAuth 换 code 的链路本期不演
  .post("/", zValidator("json", createSchema), async (c) => {
    const { db, actor } = c.get("deps");
    const input = c.req.valid("json");
    const [row] = await db
      .insert(shops)
      .values({ ...input, externalId: input.externalId ?? null })
      .returning();
    await audit(db, actor, {
      action: "shop.connect",
      entityType: "shop",
      entityId: row.id,
      payload: { platform: row.platform, site: row.site, name: row.name },
    });
    return c.json(toShop(row), 201);
  })
  .post("/:id/revoke", async (c) => {
    const { db, actor } = c.get("deps");
    const [row] = await db
      .update(shops)
      .set({ authStatus: "expired" })
      .where(eq(shops.id, c.req.param("id")))
      .returning();
    if (!row) throw notFound("店铺");
    await audit(db, actor, {
      action: "shop.revoke",
      entityType: "shop",
      entityId: row.id,
      payload: {},
    });
    return c.json(toShop(row));
  })
  .post("/:id/reauth", async (c) => {
    const { db, actor } = c.get("deps");
    const [row] = await db
      .update(shops)
      .set({ authStatus: "authorized" })
      .where(eq(shops.id, c.req.param("id")))
      .returning();
    if (!row) throw notFound("店铺");
    await audit(db, actor, {
      action: "shop.reauth",
      entityType: "shop",
      entityId: row.id,
      payload: {},
    });
    return c.json(toShop(row));
  })
  // 软删除：断开店铺只归档，历史任务的 attempt 记录与店铺行都保留
  .delete("/:id", async (c) => {
    const { db, actor } = c.get("deps");
    const [row] = await db
      .update(shops)
      .set({ archivedAt: new Date() })
      .where(eq(shops.id, c.req.param("id")))
      .returning();
    if (!row) throw notFound("店铺");
    await audit(db, actor, {
      action: "shop.archive",
      entityType: "shop",
      entityId: row.id,
      payload: { platform: row.platform, name: row.name },
    });
    return c.body(null, 204);
  });
