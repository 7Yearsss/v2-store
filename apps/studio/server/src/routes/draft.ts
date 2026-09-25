import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { listingDrafts } from "../db/schema.js";
import { audit } from "../services/audit.js";
import { ensureDraft, getProduct, patchDraft, toDraft } from "../services/draft.js";
import { runFieldAi } from "../services/ai.js";

const patchSchema = z.object({
  title: z.string().optional(),
  bullets: z.array(z.string()).optional(),
  description: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  price: z.number().nonnegative().optional(),
  compareAtPrice: z.number().nonnegative().nullable().optional(),
  category: z.string().nullable().optional(),
  upc: z.string().nullable().optional(),
});

const aiSchema = z.object({
  field: z.enum(["title", "description", "bullets", "attributes", "pricing"]),
  mode: z.enum([
    "generate",
    "shorter",
    "more_converting",
    "category_fill",
    "margin_suggest",
    "channel_rewrite",
  ]),
  channel: z.enum(["shopee", "tiktok"]).optional(),
});

export const draftRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const deps = c.get("deps");
    const d = await ensureDraft(deps.db, c.req.param("id"));
    return c.json(toDraft(d));
  })
  .patch("/", zValidator("json", patchSchema), async (c) => {
    const deps = c.get("deps");
    const d = await patchDraft(deps.db, c.req.param("id"), c.req.valid("json"));
    await audit(deps.db, deps.actor, {
      action: "draft.edit",
      entityType: "draft",
      entityId: d.id,
      payload: { fields: Object.keys(c.req.valid("json")) },
    });
    return c.json(toDraft(d));
  })
  // 字段级 AI：只回生成值——写不写入由前端确认后 PATCH（禁止静默改稿）
  .post("/ai", zValidator("json", aiSchema), async (c) => {
    const deps = c.get("deps");
    const productId = c.req.param("id");
    const { field, mode, channel } = c.req.valid("json");
    const [d, p] = await Promise.all([
      ensureDraft(deps.db, productId),
      getProduct(deps.db, productId),
    ]);
    const patch = await runFieldAi(deps, {
      productId,
      field,
      mode,
      channel,
      fields: d.fields,
      productTitle: p.title,
      sourceCategory: p.sourceCategory,
    });
    // AI 生成即写主稿并把字段记进 aiFields；前端拿到新 draft 后呈现 diff，
    // 真正"发出"仍需用户点主按钮（发布时才冻结快照）
    const aiFields = Array.from(new Set([...d.aiFields, field]));
    const [u] = await deps.db
      .update(listingDrafts)
      .set({
        fields: { ...d.fields, ...patch },
        aiFields,
        updatedAt: new Date(),
      })
      .where(eq(listingDrafts.id, d.id))
      .returning();
    await audit(deps.db, deps.actor, {
      action: "draft.ai",
      entityType: "draft",
      entityId: d.id,
      payload: { field, mode, patch },
    });
    return c.json(toDraft(u));
  });
