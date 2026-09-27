import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { StoreRow } from "../channels/types.js";
import { categoryMappings, listings, sourceItems, stores } from "../db/schema.js";
import { applyAttrMappings, loadAttrMappings } from "./attributes.js";
import { attributesToHtml, buildVariants, parseWeightKg } from "./draft.js";
import { applyAttrRules, applyImageLimit, applyTitleRules, filterSkusByPrice } from "./rules.js";
import { applyTerm, loadTermMap } from "./terms.js";

export type SourceItemRow = typeof sourceItems.$inferSelect;
export interface ClaimedListing {
  id: string;
  storeId: string;
  sourceItemId: string;
}

/**
 * 认领核心：item×store 全组合生成刊登草稿（采集预处理 + 类目/术语/属性映射预套），
 * (storeId, sourceItemId) 已存在的跳过（onConflictDoNothing → 幂等重入不重复建）。
 * 请求路由与 listing.claim job 共用；不排队 AI/链路，由调用方决定后续。
 */
export async function claimItems(
  db: Db,
  workspaceId: string,
  items: SourceItemRow[],
  targetStores: StoreRow[],
): Promise<ClaimedListing[]> {
  if (!items.length || !targetStores.length) return [];

  // 已确认的来源类目映射：同来源类目认领时直接套用
  const catIds = new Set(
    items.map((i) => i.sourceCategoryId).filter((v): v is string => !!v),
  );
  const mappings = catIds.size
    ? await db
        .select()
        .from(categoryMappings)
        .where(
          and(
            eq(categoryMappings.workspaceId, workspaceId),
            inArray(categoryMappings.sourceCategoryId, [...catIds]),
          ),
        )
    : [];
  const mappingOf = (item: SourceItemRow, store: StoreRow) =>
    mappings.find(
      (m) =>
        m.sourceCategoryId === item.sourceCategoryId &&
        m.sourcePlatform === item.sourcePlatform &&
        m.channel === store.platform,
    );

  // 术语翻译映射：每种刊登语言一份，认领时预翻选项名/值与属性
  const termMaps = new Map<string, Map<string, string>>();
  for (const store of targetStores) {
    if (!termMaps.has(store.language)) {
      termMaps.set(store.language, await loadTermMap(db, workspaceId, store.language));
    }
  }
  const termOf = (store: StoreRow) => {
    const map = termMaps.get(store.language)!;
    return (s: string) => applyTerm(map, s);
  };

  // 已确认的属性映射：按店铺平台加载一次，认领时自动套用
  const attrMaps = new Map<string, Awaited<ReturnType<typeof loadAttrMappings>>>();
  for (const store of targetStores) {
    if (!attrMaps.has(store.platform)) {
      attrMaps.set(store.platform, await loadAttrMappings(db, workspaceId, store.platform));
    }
  }

  const values = targetStores.flatMap((store) =>
    items.flatMap((item) => {
      const rules = store.rules ?? {};
      // 采集预处理：价格区间过滤 SKU；全部被滤掉则不建这条刊登。
      const skus = filterSkusByPrice(item.skus, rules, item.priceText);
      if (item.skus.length && !skus.length) return [];
      const term = termOf(store);
      const { options, variants } = buildVariants(skus, {
        skuPrefix: item.sourceItemId ?? item.id.slice(0, 8),
        priceText: item.priceText,
        pricing: store.pricing,
        termMap: term,
      });
      const mapping = mappingOf(item, store);
      const weightKg =
        parseWeightKg(applyAttrRules(item.attributes, rules)) ?? rules.defaultWeightKg ?? null;
      // 属性名译文撞名时保留原名消歧，避免两个属性合成一条丢值
      const attrSeen = new Map<string, number>();
      const attrs = Object.fromEntries(
        Object.entries(applyAttrRules(item.attributes, rules)).map(([k, v]) => {
          const tk = term(k);
          const n = (attrSeen.get(tk) ?? 0) + 1;
          attrSeen.set(tk, n);
          return [n > 1 ? `${tk}（${k}）` : tk, term(v)];
        }),
      );
      return [
        {
          workspaceId,
          storeId: store.id,
          sourceItemId: item.id,
          title: applyTitleRules(item.title, rules),
          descriptionHtml: attributesToHtml(attrs),
          images: applyImageLimit(item.images, rules),
          descImages: item.descImages.slice(0, 30),
          options,
          variants,
          tags: rules.defaultTags ?? [],
          productType: rules.defaultProductType ?? "",
          weightKg,
          // never expose the supplier as the brand
          vendor: store.vendor,
          channelCategoryId: mapping?.channelCategoryId ?? null,
          channelCategoryName: mapping?.channelCategoryName ?? null,
          channelAttributes: applyAttrMappings(
            attrMaps.get(store.platform) ?? new Map(),
            item.attributes,
            term,
          ),
          // 店铺开了「同步货源库存」的刊登默认自动回推库存（旧行为），其余只标记漂移
          syncPolicy: rules.trackStock
            ? { stock: "auto" as const, content: "notify" as const, price: "notify" as const }
            : undefined,
        },
      ];
    }),
  );
  if (!values.length) return [];
  return db
    .insert(listings)
    .values(values)
    .onConflictDoNothing({ target: [listings.storeId, listings.sourceItemId] })
    .returning({
      id: listings.id,
      storeId: listings.storeId,
      sourceItemId: listings.sourceItemId,
    });
}
