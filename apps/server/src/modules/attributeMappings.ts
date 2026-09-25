import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AttributeMapping, ChannelPlatform } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { attributeMappings } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

function toDto(r: typeof attributeMappings.$inferSelect): AttributeMapping {
  return {
    id: r.id,
    channel: r.channel as ChannelPlatform,
    sourceName: r.sourceName,
    channelAttrId: r.channelAttrId,
    channelAttrName: r.channelAttrName,
    createdAt: r.createdAt.toISOString(),
  };
}

const upsertSchema = z.object({
  channel: z.string().trim().min(1).max(30),
  sourceName: z.string().trim().min(1).max(200),
  channelAttrId: z.string().trim().min(1).max(500),
  channelAttrName: z.string().trim().min(1).max(500),
});

/** 已确认的属性映射：复核用；删除后同属性名认领/AI 提案时重新映射。 */
export function attributeMappingRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const channel = c.req.query("channel");
    const rows = await c.var.deps.db
      .select()
      .from(attributeMappings)
      .where(
        and(
          eq(attributeMappings.workspaceId, c.var.auth.workspaceId),
          channel ? eq(attributeMappings.channel, channel) : undefined,
        ),
      )
      .orderBy(desc(attributeMappings.updatedAt));
    return c.json({ items: rows.map(toDto) });
  });

  r.put("/", zValidator("json", upsertSchema), async (c) => {
    const body = c.req.valid("json");
    const [row] = await c.var.deps.db
      .insert(attributeMappings)
      .values({ workspaceId: c.var.auth.workspaceId, ...body })
      .onConflictDoUpdate({
        target: [
          attributeMappings.workspaceId,
          attributeMappings.channel,
          attributeMappings.sourceName,
        ],
        set: {
          channelAttrId: body.channelAttrId,
          channelAttrName: body.channelAttrName,
        },
      })
      .returning();
    return c.json(toDto(row!));
  });

  r.delete("/:id", async (c) => {
    const [row] = await c.var.deps.db
      .delete(attributeMappings)
      .where(
        and(
          eq(attributeMappings.id, c.req.param("id")),
          eq(attributeMappings.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .returning({ id: attributeMappings.id });
    if (!row) throw notFound("属性映射");
    return c.json({ ok: true });
  });

  return r;
}
