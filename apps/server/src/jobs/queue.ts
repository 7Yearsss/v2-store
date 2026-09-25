import { and, eq, lt, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";

export type JobRow = typeof jobs.$inferSelect;

export interface JobHandler {
  run(deps: Deps, job: JobRow): Promise<void>;
  /** called once when the job exhausts retries or throws a permanent error. */
  onFailed?(deps: Deps, job: JobRow, error: string): Promise<void>;
}

export class PermanentJobError extends Error {}

export async function enqueue(
  db: Pick<Db, "insert">,
  type: string,
  payload: Record<string, unknown>,
  opts: { workspaceId?: string; maxAttempts?: number } = {},
) {
  const [row] = await db
    .insert(jobs)
    .values({
      type,
      payload,
      workspaceId: opts.workspaceId,
      maxAttempts: opts.maxAttempts ?? 3,
    })
    .returning({ id: jobs.id });
  return row!.id;
}

/** Atomically claim the next due job (FOR UPDATE SKIP LOCKED). */
async function claimNext(db: Db): Promise<JobRow | null> {
  const result = await db.execute(sql`
    update ${jobs} set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
    where id = (
      select id from ${jobs}
      where status = 'queued' and run_at <= now()
      order by run_at
      for update skip locked
      limit 1
    )
    returning id
  `);
  const id = (result.rows[0] as { id?: string } | undefined)?.id;
  if (!id) return null;
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row ?? null;
}

/** Run one job if any is due. Returns false when the queue is idle. */
export async function runOnce(
  deps: Deps,
  handlers: Record<string, JobHandler>,
): Promise<boolean> {
  const job = await claimNext(deps.db);
  if (!job) return false;
  const handler = handlers[job.type];
  try {
    if (!handler) throw new PermanentJobError(`no handler for job type ${job.type}`);
    await handler.run(deps, job);
    await deps.db
      .update(jobs)
      .set({ status: "succeeded", lockedAt: null, lastError: null })
      .where(eq(jobs.id, job.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const permanent =
      e instanceof PermanentJobError ||
      (e as { permanent?: boolean })?.permanent === true;
    const exhausted = permanent || job.attempts >= job.maxAttempts;
    await deps.db
      .update(jobs)
      .set(
        exhausted
          ? { status: "failed", lockedAt: null, lastError: message }
          : {
              status: "queued",
              lockedAt: null,
              lastError: message,
              runAt: new Date(Date.now() + 5_000 * 2 ** job.attempts),
            },
      )
      .where(eq(jobs.id, job.id));
    if (exhausted) await handler?.onFailed?.(deps, job, message);
  }
  return true;
}

/** Requeue jobs whose worker died mid-run. */
export async function recoverStale(db: Db, olderThanMs = 10 * 60_000) {
  await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null })
    .where(
      and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(Date.now() - olderThanMs))),
    );
}

/** Poll loop; returns a stop function. */
export function startWorker(
  deps: Deps,
  handlers: Record<string, JobHandler>,
  opts: { idleMs?: number } = {},
) {
  let stopped = false;
  const idleMs = opts.idleMs ?? 1000;
  (async () => {
    await recoverStale(deps.db).catch(() => {});
    while (!stopped) {
      let worked = false;
      try {
        worked = await runOnce(deps, handlers);
      } catch (e) {
        console.error("[worker]", e);
      }
      if (!worked) await new Promise((r) => setTimeout(r, idleMs));
    }
  })();
  return () => {
    stopped = true;
  };
}
