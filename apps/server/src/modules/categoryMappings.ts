import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { CategoryMapping, ChannelPlatform, SourcePlatform } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { categoryMappings } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

function toDto(r: typeof categoryMappings.$inferSelect): CategoryMapping {
  return {
    id: r.id,
    sourcePlatform: r.sourcePlatform as SourcePlatform,
    sourceCategoryId: r.sourceCategoryId,
    sourceCategoryName: r.sourceCategoryName,
    channel: r.channel as ChannelPlatform,
    channelCategoryId: r.channelCategoryId,
    channelCategoryName: r.channelCategoryName,
    version: r.version,
    confirmedBy: r.confirmedBy,
    createdAt: r.createdAt.toISOString(),
  };
}

/** 已确认的类目映射：用户在这里复核；删除后同来源类目会重新走 AI 建议。 */
export function categoryMappingRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(categoryMappings)
      .where(eq(categoryMappings.workspaceId, c.var.auth.workspaceId))
      .orderBy(desc(categoryMappings.updatedAt))
      .limit(500);
    return c.json({ items: rows.map(toDto) });
  });

  r.delete("/:id", async (c) => {
    const [row] = await c.var.deps.db
      .delete(categoryMappings)
      .where(
        and(
          eq(categoryMappings.id, c.req.param("id")),
          eq(categoryMappings.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .returning({ id: categoryMappings.id });
    if (!row) throw notFound("类目映射");
    return c.json({ ok: true });
  });

  return r;
}
