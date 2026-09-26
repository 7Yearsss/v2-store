import { and, desc, eq } from "drizzle-orm";
import type { AuditLog } from "@studio/shared";
import type { Db } from "../db/client.js";
import { auditLogs } from "../db/schema.js";

export async function audit(
  db: Db,
  actor: string,
  entry: Omit<AuditLog, "id" | "actor" | "createdAt">,
) {
  await db.insert(auditLogs).values({ actor, ...entry });
}

export async function listAudit(
  db: Db,
  filter: { entityType?: string; entityId?: string },
): Promise<AuditLog[]> {
  const rows = await db.query.auditLogs.findMany({
    where: and(
      filter.entityType ? eq(auditLogs.entityType, filter.entityType as never) : undefined,
      filter.entityId ? eq(auditLogs.entityId, filter.entityId) : undefined,
    ),
    orderBy: desc(auditLogs.createdAt),
    limit: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}
