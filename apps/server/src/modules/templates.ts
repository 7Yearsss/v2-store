import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { ListingTemplate, StoreSettingsPayload } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { listingTemplates } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

function toDto(r: typeof listingTemplates.$inferSelect): ListingTemplate {
  return {
    id: r.id,
    name: r.name,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  };
}

const payloadSchema = z.object({
  pricing: z.object({
    exchangeRate: z.number().positive(),
    markup: z.number().positive(),
    priceEnding: z.number().min(0).max(0.99).nullable().optional(),
    extraCostCny: z.number().min(0).optional(),
    minPrice: z.number().min(0).nullable().optional(),
  }),
  vendor: z.string().max(255).default(""),
  aiEnhance: z.boolean().default(true),
  language: z.string().trim().min(2).max(32).default("en"),
  rules: z.record(z.string(), z.unknown()).default({}),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  payload: payloadSchema,
});

/** 刊登模板：店铺设置预设的增删查；套用是前端把 payload 填回设置表单。 */
export function templateRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(listingTemplates)
      .where(eq(listingTemplates.workspaceId, c.var.auth.workspaceId))
      .orderBy(desc(listingTemplates.updatedAt));
    return c.json({ items: rows.map(toDto) });
  });

  /** 同名覆盖更新（幂等存模板）。 */
  r.post("/", zValidator("json", createSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { name, payload } = c.req.valid("json");
    const [row] = await db
      .insert(listingTemplates)
      .values({ workspaceId, name, payload: payload as StoreSettingsPayload })
      .onConflictDoUpdate({
        target: [listingTemplates.workspaceId, listingTemplates.name],
        set: { payload: payload as StoreSettingsPayload, updatedAt: new Date() },
      })
      .returning();
    return c.json({ item: toDto(row!) });
  });

  r.delete("/:id", async (c) => {
    const [row] = await c.var.deps.db
      .delete(listingTemplates)
      .where(
        and(
          eq(listingTemplates.id, c.req.param("id")),
          eq(listingTemplates.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .returning({ id: listingTemplates.id });
    if (!row) throw notFound("刊登模板");
    return c.json({ ok: true });
  });

  return r;
}
