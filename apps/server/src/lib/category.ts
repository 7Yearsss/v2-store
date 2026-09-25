import { and, eq, or, sql } from "drizzle-orm";
import type { CategoryCandidate, SourcePlatform } from "@caiji/shared";
import type { Db } from "../db/client.js";
import { categoryMappings, channelCategories } from "../db/schema.js";

/** Shopify taxonomy 没有显式版本号；平台迁移类目时改这里即可让旧映射作废。 */
export const TAXONOMY_VERSION = "taxonomy";

export type MappingRow = typeof categoryMappings.$inferSelect;

/** 已确认的来源类目映射（同来源类目认领/发布时直接套用）。 */
export async function resolveCategoryMapping(
  db: Db,
  workspaceId: string,
  sourcePlatform: SourcePlatform,
  sourceCategoryId: string,
  channel: string,
): Promise<MappingRow | null> {
  const [m] = await db
    .select()
    .from(categoryMappings)
    .where(
      and(
        eq(categoryMappings.workspaceId, workspaceId),
        eq(categoryMappings.sourcePlatform, sourcePlatform),
        eq(categoryMappings.sourceCategoryId, sourceCategoryId),
        eq(categoryMappings.channel, channel),
      ),
    )
    .limit(1);
  return m ?? null;
}

/** 记住一次确认（用户选了候选或手动指定）；同键覆盖。 */
export async function upsertCategoryMapping(
  db: Db,
  row: {
    workspaceId: string;
    sourcePlatform: string;
    sourceCategoryId: string;
    sourceCategoryName?: string | null;
    channel: string;
    candidate: CategoryCandidate;
    confidence?: number;
    confirmedBy: "user" | "ai";
    version?: string;
  },
) {
  const values = {
    workspaceId: row.workspaceId,
    sourcePlatform: row.sourcePlatform,
    sourceCategoryId: row.sourceCategoryId,
    sourceCategoryName: row.sourceCategoryName ?? null,
    channel: row.channel,
    channelCategoryId: row.candidate.id,
    channelCategoryName: row.candidate.fullName || row.candidate.name,
    version: row.version ?? TAXONOMY_VERSION,
    confidence: row.confidence ?? (row.confirmedBy === "user" ? 100 : 0),
    confirmedBy: row.confirmedBy,
  };
  const [saved] = await db
    .insert(categoryMappings)
    .values(values)
    .onConflictDoUpdate({
      target: [
        categoryMappings.workspaceId,
        categoryMappings.sourcePlatform,
        categoryMappings.sourceCategoryId,
        categoryMappings.channel,
      ],
      set: {
        channelCategoryId: values.channelCategoryId,
        channelCategoryName: values.channelCategoryName,
        sourceCategoryName: values.sourceCategoryName,
        version: values.version,
        confidence: values.confidence,
        confirmedBy: values.confirmedBy,
        updatedAt: new Date(),
      },
    })
    .returning();
  return saved!;
}

/** 平台类目树缓存：AI 搜到的候选节点按 (platform, version, id) 记住。 */
export async function cacheCategoryNodes(
  db: Db,
  platform: string,
  version: string,
  candidates: CategoryCandidate[],
) {
  if (!candidates.length) return;
  await db
    .insert(channelCategories)
    .values(
      candidates.map((cd) => ({
        platform,
        version,
        categoryId: cd.id,
        name: cd.name,
        path: cd.fullName ? cd.fullName.split(/\s*>\s*/) : [cd.name],
      })),
    )
    .onConflictDoNothing({
      target: [
        channelCategories.platform,
        channelCategories.version,
        channelCategories.categoryId,
      ],
    });
}

/** 本地类目缓存搜索（手动选类目）：名字或路径命中即返回。 */
export async function searchCachedCategories(
  db: Db,
  platform: string,
  query: string,
  version = TAXONOMY_VERSION,
  limit = 20,
): Promise<CategoryCandidate[]> {
  if (!query.trim()) return [];
  const q = `%${query.trim()}%`;
  const rows = await db
    .select()
    .from(channelCategories)
    .where(
      and(
        eq(channelCategories.platform, platform),
        eq(channelCategories.version, version),
        or(
          sql`${channelCategories.name} ilike ${q}`,
          sql`${channelCategories.path}::text ilike ${q}`,
        ),
      ),
    )
    .limit(limit);
  return rows.map((r) => ({
    id: r.categoryId,
    name: r.name,
    fullName: (r.path as string[]).join(" > "),
  }));
}
