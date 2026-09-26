import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type {
  DiscoveryItem,
  DiscoveryItemStatus,
  SelectionPlan,
} from "@caiji/shared";
import type { AppEnv, Deps } from "../context.js";
import { discoveryItems, selectionPlans } from "../db/schema.js";
import { HttpError, notFound } from "../lib/errors.js";
import {
  planIsDue,
  planUrls,
  upsertDiscoveryItems,
} from "../lib/selection.js";
import { enqueueSelectionScore } from "../jobs/handlers.js";
import { requireAuth } from "./auth.js";

const filtersSchema = z
  .object({
    keywords: z.array(z.string().trim().min(1)).max(10).optional(),
    category: z.string().trim().optional(),
    priceMinCny: z.number().min(0).optional(),
    priceMaxCny: z.number().min(0).optional(),
    requireDaiFa: z.boolean().optional(),
    require48h: z.boolean().optional(),
    minRepurchase: z.number().min(0).max(1).optional(),
  })
  .default({});

const planCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  source: z.enum(["keyword", "1688_rank"]).default("keyword"),
  filters: filtersSchema,
  schedule: z.enum(["manual", "daily"]).default("manual"),
  enabled: z.boolean().default(true),
});

const planPatchSchema = planCreateSchema.partial();

const feedItemSchema = z.object({
  sourceItemId: z.string().trim().min(3).max(64),
  title: z.string().max(200).optional(),
  priceText: z.string().max(60).optional(),
  thumb: z.string().max(1000).optional(),
  signals: z
    .object({
      daiFa: z.boolean().optional(),
      ship48h: z.boolean().optional(),
      repurchaseRate: z.number().min(0).max(1).optional(),
      sellerYears: z.number().min(0).optional(),
      rank: z.number().int().min(1).optional(),
      sourceRank: z.number().int().min(1).optional(),
      sameStyleCount: z.number().int().min(0).optional(),
    })
    .optional(),
});

const feedSchema = z.object({
  planId: z.string().uuid().nullish(),
  items: z.array(feedItemSchema).max(200),
});

const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

function toPlanDto(
  p: typeof selectionPlans.$inferSelect,
  extra?: { itemCount?: number; newCount?: number; due?: boolean; urls?: string[] },
): SelectionPlan {
  return {
    id: p.id,
    name: p.name,
    source: p.source as SelectionPlan["source"],
    filters: p.filters,
    schedule: p.schedule as SelectionPlan["schedule"],
    enabled: p.enabled,
    lastRunAt: p.lastRunAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    ...extra,
  };
}

type ItemRow = typeof discoveryItems.$inferSelect;

function toItemDto(row: ItemRow, planName?: string | null): DiscoveryItem {
  return {
    id: row.id,
    planId: row.planId,
    planName: planName ?? null,
    sourcePlatform: row.sourcePlatform as DiscoveryItem["sourcePlatform"],
    sourceItemId: row.sourceItemId,
    title: row.title,
    priceText: row.priceText,
    thumb: row.thumb,
    signals: row.signals,
    score: row.score,
    aiNote: row.aiNote,
    status: row.status as DiscoveryItemStatus,
    sourceItemDbId: row.sourceItemDbId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getPlan(deps: Deps, workspaceId: string, id: string) {
  const [plan] = await deps.db
    .select()
    .from(selectionPlans)
    .where(and(eq(selectionPlans.id, id), eq(selectionPlans.workspaceId, workspaceId)))
    .limit(1);
  if (!plan) throw notFound("选品计划");
  return plan;
}

export function selectionPlanRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const { workspaceId } = c.var.auth;
    const db = c.var.deps.db;
    const [plans, counts] = await Promise.all([
      db
        .select()
        .from(selectionPlans)
        .where(eq(selectionPlans.workspaceId, workspaceId))
        .orderBy(desc(selectionPlans.createdAt)),
      db
        .select({
          planId: discoveryItems.planId,
          total: count(),
          fresh: sql<number>`count(*) filter (where ${discoveryItems.status} = 'new')`,
        })
        .from(discoveryItems)
        .where(eq(discoveryItems.workspaceId, workspaceId))
        .groupBy(discoveryItems.planId),
    ]);
    const byPlan = new Map(counts.map((row) => [row.planId, row]));
    return c.json({
      items: plans.map((p) =>
        toPlanDto(p, {
          itemCount: byPlan.get(p.id)?.total ?? 0,
          newCount: byPlan.get(p.id)?.fresh ?? 0,
          due: planIsDue(p),
        }),
      ),
    });
  });

  r.post("/", zValidator("json", planCreateSchema), async (c) => {
    const { workspaceId } = c.var.auth;
    const body = c.req.valid("json");
    const [plan] = await c.var.deps.db
      .insert(selectionPlans)
      .values({ workspaceId, ...body })
      .returning();
    return c.json(toPlanDto(plan, { due: true }), 201);
  });

  r.patch("/:id", zValidator("json", planPatchSchema), async (c) => {
    const { workspaceId } = c.var.auth;
    const plan = await getPlan(c.var.deps, workspaceId, c.req.param("id"));
    const body = c.req.valid("json");
    const [updated] = await c.var.deps.db
      .update(selectionPlans)
      .set(body)
      .where(eq(selectionPlans.id, plan.id))
      .returning();
    return c.json(toPlanDto(updated));
  });

  r.delete("/:id", async (c) => {
    const { workspaceId } = c.var.auth;
    const plan = await getPlan(c.var.deps, workspaceId, c.req.param("id"));
    await c.var.deps.db.delete(selectionPlans).where(eq(selectionPlans.id, plan.id));
    return c.json({ ok: true });
  });

  // run-now：记录 runRequestedAt（manual 计划靠它到期被插件抓），
  // 同时给现有候选补一次打分。
  r.post("/:id/run", async (c) => {
    const { workspaceId } = c.var.auth;
    const plan = await getPlan(c.var.deps, workspaceId, c.req.param("id"));
    const runRequestedAt = new Date();
    await c.var.deps.db
      .update(selectionPlans)
      .set({ runRequestedAt })
      .where(eq(selectionPlans.id, plan.id));
    await enqueueSelectionScore(c.var.deps.db, workspaceId, plan.id);
    return c.json(toPlanDto({ ...plan, runRequestedAt }, { due: true }));
  });

  return r;
}

export function discoveryRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get(
    "/items",
    zValidator(
      "query",
      z.object({
        planId: z.string().uuid().optional(),
        status: z.enum(["new", "collected", "dismissed", "expired"]).optional(),
        minScore: z.coerce.number().min(0).max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(40),
      }),
    ),
    async (c) => {
      const { workspaceId } = c.var.auth;
      const q = c.req.valid("query");
      const where = and(
        eq(discoveryItems.workspaceId, workspaceId),
        q.planId ? eq(discoveryItems.planId, q.planId) : undefined,
        q.status ? eq(discoveryItems.status, q.status) : undefined,
        q.minScore != null
          ? sql`coalesce(${discoveryItems.score}, 0) >= ${q.minScore}`
          : undefined,
      );
      const db = c.var.deps.db;
      const [rows, total] = await Promise.all([
        db
          .select({ item: discoveryItems, planName: selectionPlans.name })
          .from(discoveryItems)
          .leftJoin(selectionPlans, eq(discoveryItems.planId, selectionPlans.id))
          .where(where)
          .orderBy(
            desc(sql`coalesce(${discoveryItems.score}, -1)`),
            desc(discoveryItems.createdAt),
          )
          .limit(q.pageSize)
          .offset((q.page - 1) * q.pageSize),
        db.select({ n: count() }).from(discoveryItems).where(where),
      ]);
      return c.json({
        items: rows.map((row) => toItemDto(row.item, row.planName)),
        total: total[0]?.n ?? 0,
      });
    },
  );

  // 插件回流：upsert 幂等键 (workspace, plan, source_item_id)。
  r.post("/feed", zValidator("json", feedSchema), async (c) => {
    const { workspaceId } = c.var.auth;
    const body = c.req.valid("json");
    const db = c.var.deps.db;
    const planId = body.planId ?? null;
    if (planId) await getPlan(c.var.deps, workspaceId, planId);
    const result = await upsertDiscoveryItems(db, workspaceId, planId, body.items);
    if (planId) {
      await db
        .update(selectionPlans)
        .set({ lastRunAt: new Date() })
        .where(eq(selectionPlans.id, planId));
    }
    if (result.inserted + result.updated > 0) {
      await enqueueSelectionScore(db, workspaceId, planId);
    }
    return c.json(result);
  });

  // 插件 alarm 轮询：所有启用计划（被动匹配要用 filters），due=true 的带抓取 URL。
  r.get("/tasks", async (c) => {
    const { workspaceId } = c.var.auth;
    const plans = await c.var.deps.db
      .select()
      .from(selectionPlans)
      .where(and(eq(selectionPlans.workspaceId, workspaceId), eq(selectionPlans.enabled, true)))
      .orderBy(selectionPlans.createdAt);
    return c.json({
      items: plans.map((p) => {
        const due = planIsDue(p);
        return toPlanDto(p, { due, urls: due ? planUrls(p) : [] });
      }),
    });
  });

  // 勾选采集：校验归属与状态，返回卡片信息供前端挂进插件待确认队列；
  // 真正入库走 /api/collect（详情页重采），在那里回填 status/sourceItemDbId。
  r.post("/collect", zValidator("json", idsSchema), async (c) => {
    const { workspaceId } = c.var.auth;
    const { ids } = c.req.valid("json");
    const rows = await c.var.deps.db
      .select()
      .from(discoveryItems)
      .where(
        and(
          eq(discoveryItems.workspaceId, workspaceId),
          inArray(discoveryItems.id, ids),
          eq(discoveryItems.status, "new"),
        ),
      );
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        offerId: row.sourceItemId,
        title: row.title ?? row.sourceItemId,
        image: row.thumb,
        price: row.priceText,
      })),
    });
  });

  r.post("/dismiss", zValidator("json", idsSchema), async (c) => {
    const { workspaceId } = c.var.auth;
    const { ids } = c.req.valid("json");
    const updated = await c.var.deps.db
      .update(discoveryItems)
      .set({ status: "dismissed" })
      .where(
        and(
          eq(discoveryItems.workspaceId, workspaceId),
          inArray(discoveryItems.id, ids),
          eq(discoveryItems.status, "new"),
        ),
      )
      .returning({ id: discoveryItems.id });
    return c.json({ dismissed: updated.length });
  });

  return r;
}
