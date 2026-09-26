import type { AuditLog } from "@caiji/shared";
import { desc, eq, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditLogs } from "../db/schema.js";

/** 所有需要留痕的动作（用户发布、系统自动动作）统一走这里。 */
export async function audit(
  db: Pick<Db, "insert">,
  workspaceId: string,
  entry: {
    actor?: string;
    action: string;
    entityType: string;
    entityId: string;
    payload?: Record<string, unknown>;
  },
) {
  await db.insert(auditLogs).values({
    workspaceId,
    actor: entry.actor ?? "system",
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    payload: entry.payload ?? {},
  });
}

export function toAuditDto(r: typeof auditLogs.$inferSelect): AuditLog {
  return {
    id: r.id,
    actor: r.actor,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  };
}

/** 某实体的审计时间线（倒序，限定 workspace）。 */
export async function listAudits(
  db: Db,
  workspaceId: string,
  entityType: string,
  entityId: string,
  limit = 50,
) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.workspaceId, workspaceId),
        eq(auditLogs.entityType, entityType),
        eq(auditLogs.entityId, entityId),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows.map(toAuditDto);
}
