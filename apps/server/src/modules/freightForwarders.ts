import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { FreightForwarder } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { freightForwarders } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

/** 货代收货地址簿（仓储 L2）：采购下单时把货代仓地址贴进 1688 订单。 */
export function freightForwarderRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  const bodySchema = z.object({
    name: z.string().trim().min(1).max(100),
    receiver: z.string().trim().max(100).nullable().optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    country: z.string().trim().max(100).nullable().optional(),
    province: z.string().trim().max(100).nullable().optional(),
    city: z.string().trim().max(100).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    zipcode: z.string().trim().max(20).nullable().optional(),
    systemType: z.string().trim().max(50).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  });

  const toDto = (f: typeof freightForwarders.$inferSelect): FreightForwarder => ({
    id: f.id,
    name: f.name,
    receiver: f.receiver,
    phone: f.phone,
    country: f.country,
    province: f.province,
    city: f.city,
    address: f.address,
    zipcode: f.zipcode,
    systemType: f.systemType,
    note: f.note,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  });

  r.get("/", async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(freightForwarders)
      .where(eq(freightForwarders.workspaceId, c.var.auth.workspaceId))
      .orderBy(desc(freightForwarders.createdAt));
    return c.json({ items: rows.map(toDto) });
  });

  r.post("/", zValidator("json", bodySchema), async (c) => {
    const [row] = await c.var.deps.db
      .insert(freightForwarders)
      .values({ workspaceId: c.var.auth.workspaceId, ...c.req.valid("json") })
      .returning();
    return c.json(toDto(row!), 201);
  });

  r.patch("/:id", zValidator("json", bodySchema.partial()), async (c) => {
    const [row] = await c.var.deps.db
      .update(freightForwarders)
      .set({ ...c.req.valid("json"), updatedAt: new Date() })
      .where(
        and(
          eq(freightForwarders.id, c.req.param("id")),
          eq(freightForwarders.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .returning();
    if (!row) throw notFound("货代");
    return c.json(toDto(row));
  });

  r.delete("/:id", async (c) => {
    const [row] = await c.var.deps.db
      .delete(freightForwarders)
      .where(
        and(
          eq(freightForwarders.id, c.req.param("id")),
          eq(freightForwarders.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .returning({ id: freightForwarders.id });
    if (!row) throw notFound("货代");
    return c.json({ ok: true });
  });

  return r;
}
