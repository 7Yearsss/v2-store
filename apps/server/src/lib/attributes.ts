import type { ChannelAttribute, ListingChannelAttribute } from "@caiji/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Deps } from "../context.js";
import type { StoreRow } from "../channels/types.js";
import { adapterFor } from "../channels/index.js";
import { attributeMappings, channelCategories } from "../db/schema.js";
import { TAXONOMY_VERSION } from "./category.js";

type AttrMapTarget = { attrId: string; attrName: string };

/** Load confirmed sourceName → channel attribute mappings for one channel. */
export async function loadAttrMappings(
  db: Db,
  workspaceId: string,
  channel: string,
): Promise<Map<string, AttrMapTarget>> {
  const rows = await db
    .select()
    .from(attributeMappings)
    .where(
      and(
        eq(attributeMappings.workspaceId, workspaceId),
        eq(attributeMappings.channel, channel),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.sourceName,
      { attrId: r.channelAttrId, attrName: r.channelAttrName },
    ]),
  );
}

/** Apply confirmed mappings onto 1688 source attributes (name-exact). */
export function applyAttrMappings(
  map: Map<string, AttrMapTarget>,
  attrs: Record<string, string>,
): ListingChannelAttribute[] {
  const out: ListingChannelAttribute[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(attrs)) {
    const m = map.get(name);
    if (!m || seen.has(m.attrId)) continue;
    seen.add(m.attrId);
    out.push({ attrId: m.attrId, name: m.attrName, value: String(value).slice(0, 500) });
  }
  return out;
}

/** Learn sourceName → attrId pairs (accept of an AI proposal or manual set). */
export async function upsertAttrMappings(
  db: Db,
  workspaceId: string,
  channel: string,
  pairs: Array<{ sourceName: string; attrId: string; attrName: string }>,
) {
  const seen = new Set<string>();
  const values = pairs
    .filter((p) => {
      const key = p.sourceName.trim();
      if (!key || !p.attrId.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 500)
    .map((p) => ({
      workspaceId,
      channel,
      sourceName: p.sourceName.trim(),
      channelAttrId: p.attrId.trim(),
      channelAttrName: p.attrName.trim() || p.attrId.trim(),
    }));
  if (!values.length) return;
  await db
    .insert(attributeMappings)
    .values(values)
    .onConflictDoUpdate({
      target: [
        attributeMappings.workspaceId,
        attributeMappings.channel,
        attributeMappings.sourceName,
      ],
      set: {
        channelAttrId: attributeMappings.channelAttrId,
        channelAttrName: attributeMappings.channelAttrName,
      },
    });
}

/**
 * Category's standard attributes, lazily fetched through the adapter and
 * cached on the channel_categories row's attributesSchema. Empty array when
 * the platform has no attribute support.
 */
export async function cachedCategoryAttributes(
  db: Db,
  deps: Deps,
  store: StoreRow,
  categoryId: string,
): Promise<ChannelAttribute[]> {
  const [row] = await db
    .select()
    .from(channelCategories)
    .where(
      and(
        eq(channelCategories.platform, store.platform),
        eq(channelCategories.version, TAXONOMY_VERSION),
        eq(channelCategories.categoryId, categoryId),
      ),
    );
  const cached = row?.attributesSchema?.attributes;
  if (cached?.length) return cached;

  const adapter = adapterFor(store.platform);
  if (!adapter.categoryAttributes) return [];
  const attrs = await adapter.categoryAttributes(deps, store, categoryId);
  if (row) {
    await db
      .update(channelCategories)
      .set({ attributesSchema: { attributes: attrs } })
      .where(eq(channelCategories.id, row.id));
  } else {
    await db
      .insert(channelCategories)
      .values({
        platform: store.platform,
        version: TAXONOMY_VERSION,
        categoryId,
        name: "",
        path: [],
        attributesSchema: { attributes: attrs },
      })
      .onConflictDoNothing();
  }
  return attrs;
}
