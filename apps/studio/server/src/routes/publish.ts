import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { audit } from "../services/audit.js";
import {
  channelCheck,
  createPublishJob,
  getJob,
  listJobs,
  retryAttempt,
} from "../services/publish.js";

export const publishRoutes = new Hono<AppEnv>()
  // 右栏对照预览：对选中店铺跑一遍校验（不发布）
  .post(
    "/preview",
    zValidator(
      "json",
      z.object({ productId: z.string().uuid(), shopIds: z.array(z.string().uuid()).min(1) }),
    ),
    async (c) => {
      const deps = c.get("deps");
      const checks = await channelCheck(deps, c.req.valid("json"));
      return c.json({ checks });
    },
  )
  // 一键铺货：建 job + 每店 attempt，异步跑
  .post(
    "/jobs",
    zValidator(
      "json",
      z.object({ productId: z.string().uuid(), shopIds: z.array(z.string().uuid()).min(1) }),
    ),
    async (c) => {
      const deps = c.get("deps");
      const detail = await createPublishJob(deps, c.req.valid("json"));
      await audit(deps.db, deps.actor, {
        action: "publish.create",
        entityType: "job",
        entityId: detail.job.id,
        payload: {
          productId: detail.job.productId,
          shopIds: detail.job.shopIds,
          fields: detail.job.fieldsSnapshot,
        },
      });
      return c.json(detail, 201);
    },
  )
  .get("/jobs", async (c) => {
    const deps = c.get("deps");
    const page = Math.max(1, Number(c.req.query("page") ?? 1));
    return c.json(await listJobs(deps, page));
  })
  .get("/jobs/:id", async (c) => {
    const deps = c.get("deps");
    return c.json(await getJob(deps, c.req.param("id")));
  })
  .post("/attempts/:id/retry", async (c) => {
    const deps = c.get("deps");
    const detail = await retryAttempt(deps, c.req.param("id"));
    await audit(deps.db, deps.actor, {
      action: "attempt.retry",
      entityType: "attempt",
      entityId: c.req.param("id"),
      payload: {},
    });
    return c.json(detail);
  });
