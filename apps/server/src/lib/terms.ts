import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { termMappings } from "../db/schema.js";

/** 载入某刊登语言的全部术语映射。空语言只命中 lang="" 的桶。 */
export async function loadTermMap(
  db: Db,
  workspaceId: string,
  lang: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      lang: termMappings.lang,
      sourceText: termMappings.sourceText,
      targetText: termMappings.targetText,
    })
    .from(termMappings)
    .where(eq(termMappings.workspaceId, workspaceId));
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.lang === lang) map.set(r.sourceText, r.targetText);
  }
  return map;
}

/** 精确匹配翻译；未命中原样返回。 */
export function applyTerm(map: Map<string, string>, s: string): string {
  return map.get(s) ?? s;
}

/** 学习词对：只写 源词≠译文 且都非空的，重复键更新译文（最近确认生效）。 */
export async function upsertTermPairs(
  tx: Db,
  workspaceId: string,
  lang: string,
  pairs: Array<[string, string]>,
) {
  const seen = new Set<string>();
  const clean = pairs
    .map(([s, t]): [string, string] => [s.trim(), t.trim()])
    .filter(([s, t]) => s && t && s !== t && !seen.has(s) && seen.add(s));
  for (const [sourceText, targetText] of clean.slice(0, 500)) {
    await tx
      .insert(termMappings)
      .values({ workspaceId, lang, sourceText, targetText })
      .onConflictDoUpdate({
        target: [
          termMappings.workspaceId,
          termMappings.lang,
          termMappings.sourceText,
        ],
        set: { targetText, updatedAt: new Date() },
      });
  }
}
