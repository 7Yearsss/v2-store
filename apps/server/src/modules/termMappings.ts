import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { TermMapping } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { termMappings } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

function toDto(r: typeof termMappings.$inferSelect): TermMapping {
  return {
    id: r.id,
    lang: r.lang,
    sourceText: r.sourceText,
    targetText: r.targetText,
    createdAt: r.createdAt.toISOString(),
  };
}

const upsertSchema = z.object({
  lang: z.string().trim().max(20).default(""),
  sourceText: z.string().trim().min(1).max(500),
  targetText: z.string().trim().min(1).max(500),
});

/** 术语翻译映射：认领时预翻选项名/值与属性；AI 建议被接受时自动学习。 */
export function termMappingRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const lang = c.req.query("lang");
    const rows = await c.var.deps.db
      .select()
      .from(termMappings)
      .where(
        and(
          eq(termMappings.workspaceId, c.var.auth.workspaceId),
          lang != null ? eq(termMappings.lang, lang) : undefined,
        ),
      )
      .orderBy(desc(termMappings.updatedAt));
    return c.json({ items: rows.map(toDto) });
  });

  /** 手动增改：同 lang+源词 覆盖更新译文。 */
  r.put("/", zValidator("json", upsertSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { lang, sourceText, targetText } = c.req.valid("json");
    const [row] = await db
      .insert(termMappings)
      .values({ workspaceId, lang, sourceText, targetText })
      .onConflictDoUpdate({
        target: [termMappings.workspaceId, termMappings.lang, termMappings.sourceText],
        set: { targetText, updatedAt: new Date() },
      })
      .returning();
    return c.json({ item: toDto(row!) });
  });

  r.delete("/:id", async (c) => {
    const [row] = await c.var.deps.db
      .delete(termMappings)
      .where(
        and(
          eq(termMappings.id, c.req.param("id")),
          eq(termMappings.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .returning({ id: termMappings.id });
    if (!row) throw notFound("术语映射");
    return c.json({ ok: true });
  });

  return r;
}
