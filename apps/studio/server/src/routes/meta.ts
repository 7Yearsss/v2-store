import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { platformMetas } from "../platforms/index.js";
import { listAudit } from "../services/audit.js";

export const metaRoutes = new Hono<AppEnv>()
  .get("/platforms", (c) => c.json({ items: platformMetas() }))
  .get("/audit-logs", async (c) => {
    const { db } = c.get("deps");
    const items = await listAudit(db, {
      entityType: c.req.query("entityType"),
      entityId: c.req.query("entityId"),
    });
    return c.json({ items, total: items.length });
  });
