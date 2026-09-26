import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { FreightForwarder } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { freightForwarders } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

type Row = typeof freightForwarders.$inferSelect;

const addressSchema = z.object({
  recipient: z.string().trim().max(64).optional(),
  phone: z.string().trim().max(32).optional(),
  country: z.string().trim().max(64).optional(),
  province: z.string().trim().max(64).optional(),
  city: z.string().trim().max(64).optional(),
  address1: z.string().trim().min(1).max(255),
  address2: z.string().trim().max(255).optional(),
  postcode: z.string().trim().max(16).optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  address: addressSchema,
  /** 货代系统类型：huoxiaoyi（可直连）|manual 等。 */
  systemType: z.string().trim().max(50).optional(),
  note: z.string().trim().max(500).optional(),
});
const patchSchema = createSchema.partial();

const toDto = (r: Row): FreightForwarder => ({
  id: r.id,
  name: r.name,
  address: r.address,
  systemType: r.systemType,
  note: r.note,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** 货代地址簿：采购单收货地址的切换来源。 */
export function freightForwarderRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(freightForwarders)
      .where(eq(freightForwarders.workspaceId, c.var.auth.workspaceId));
    return c.json({ items: rows.map(toDto), total: rows.length });
  });

  r.post("/", zValidator("json", createSchema), async (c) => {
    const body = c.req.valid("json");
    const [row] = await c.var.deps.db
      .insert(freightForwarders)
      .values({
        workspaceId: c.var.auth.workspaceId,
        name: body.name,
        address: body.address,
        note: body.note ?? null,
      })
      .returning();
    return c.json(toDto(row!), 201);
  });

  r.patch("/:id", zValidator("json", patchSchema), async (c) => {
    const [row] = await c.var.deps.db
      .update(freightForwarders)
      .set(c.req.valid("json"))
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
