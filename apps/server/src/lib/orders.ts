import { and, eq, inArray } from "drizzle-orm";
import type {
  Order,
  OrderItem,
  OrderStatus,
  RemoteOrder,
  Shipment,
  ShippingAddress,
} from "@caiji/shared";
import type { StoreRow } from "../channels/types.js";
import type { Deps } from "../context.js";
import type { Db } from "../db/client.js";
import {
  listings,
  orderItems,
  orders,
  purchaseOrderItems,
  purchaseOrders,
  shipments,
  sourceItems,
  stores,
} from "../db/schema.js";
import { audit } from "./audit.js";

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;

// --- 地址：库内只存密文，出参只给脱敏摘要 -------------------------------------

const maskName = (s?: string | null) =>
  s && s.trim() ? `${s.trim()[0]}${"*".repeat(Math.min(Math.max(s.trim().length - 1, 1), 3))}` : null;
const maskPhone = (s?: string | null) =>
  s && s.replace(/\D/g, "").length >= 7
    ? `${s.slice(0, 3)}****${s.slice(-4)}`
    : s
      ? "***"
      : null;
const maskEmail = (s?: string | null) => {
  if (!s || !s.includes("@")) return s ? "***" : null;
  const [user, domain] = s.split("@");
  return `${user!.slice(0, 1)}***@${domain}`;
};

/** 一行脱敏摘要：列表/详情唯一允许出现的地址形态。 */
export function maskAddress(a: ShippingAddress | null | undefined): string | null {
  if (!a) return null;
  const parts = [
    [a.country, a.province, a.city].filter(Boolean).join(" ") || null,
    maskName(a.recipient),
    maskPhone(a.phone),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function maskCustomer(
  c: { name?: string | null; email?: string | null; phone?: string | null } | null | undefined,
) {
  if (!c) return null;
  return {
    name: maskName(c.name) ?? undefined,
    email: maskEmail(c.email) ?? undefined,
    phone: maskPhone(c.phone) ?? undefined,
  };
}

export function openAddress(deps: Deps, row: OrderRow): ShippingAddress | null {
  if (!row.shippingAddressEnc) return null;
  try {
    return deps.secrets.open<ShippingAddress>(row.shippingAddressEnc);
  } catch {
    return null;
  }
}

// --- 状态派生（纯函数） --------------------------------------------------------

/**
 * 订单总状态 = 远端事实（取消/财务/履约）+ 本地流程（审核闸 + 行项采购进度 + 运单推送）。
 * 优先级从上到下；reviewedAt 是 new → to_procure 的人工闸。
 */
export function deriveOrderStatus(
  o: Pick<OrderRow, "financialStatus" | "fulfillmentStatus" | "reviewedAt" | "raw">,
  items: Pick<OrderItemRow, "procureStatus" | "mapping">[],
  ships: Pick<typeof shipments.$inferSelect, "status">[],
): OrderStatus {
  const cancelledAt = (o.raw as { cancelledAt?: string | null } | null)?.cancelledAt;
  if (cancelledAt || o.financialStatus === "VOIDED") return "cancelled";
  if (
    items.some((i) => i.procureStatus === "failed") ||
    ships.some((s) => s.status === "failed")
  ) {
    return "exception";
  }
  if (o.fulfillmentStatus === "FULFILLED") {
    return o.financialStatus === "PAID" ? "done" : "shipped";
  }
  if (ships.some((s) => s.status === "pushed")) return "shipped";
  if (!o.reviewedAt) return "new";
  const procurable = items.filter((i) => i.mapping !== "unmatched");
  // 全部行已匹配且全部采购完成才算可发货；procurable 为空时 every 误过
  if (items.length && procurable.length === items.length && procurable.every((i) => i.procureStatus === "done")) return "to_ship";
  if (items.some((i) => ["queued", "placed", "shipped"].includes(i.procureStatus))) {
    return "procuring";
  }
  return "to_procure";
}

/** 重算并写回订单状态；变化时落 audit_logs（订单域事件的唯一出口）。 */
export async function refreshOrderStatus(
  deps: Pick<Deps, "db">,
  orderId: string,
  actor = "system",
): Promise<OrderStatus | null> {
  const [o] = await deps.db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) return null;
  const items = await deps.db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const ships = await deps.db
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, orderId));
  const next = deriveOrderStatus(o, items, ships);
  if (next === o.status) return next;
  await deps.db
    .update(orders)
    .set({ status: next })
    .where(eq(orders.id, orderId));
  await audit(deps.db, o.workspaceId, {
    actor,
    action: "order.status",
    entityType: "order",
    entityId: orderId,
    payload: { from: o.status, to: next },
  });
  return next;
}

// --- 同步 upsert --------------------------------------------------------------

/**
 * Upsert one remote order + its line items.
 * 幂等键：store_id+remote_id 唯一 + 新鲜度（incoming updatedAt <= 已存 raw.updatedAt → 跳过整写）。
 * 行项按 (order_id, remote_line_item_id) upsert，人工绑定字段（listingId/sourceItemId/
 * sourceSkuId/mapping/procureStatus）不覆盖。
 */
export async function upsertRemoteOrder(
  deps: Deps,
  store: StoreRow,
  remote: RemoteOrder,
): Promise<{ orderId: string; created: boolean; skipped: boolean }> {
  const [existing] = await deps.db
    .select()
    .from(orders)
    .where(and(eq(orders.storeId, store.id), eq(orders.remoteId, remote.remoteId)))
    .limit(1);

  const incomingAt = remote.updatedAt ? Date.parse(remote.updatedAt) : null;
  const storedAt = (existing?.raw as { updatedAt?: string } | null)?.updatedAt;
  if (existing && incomingAt != null && storedAt && incomingAt <= Date.parse(storedAt)) {
    return { orderId: existing.id, created: false, skipped: true };
  }

  const enc = remote.shippingAddress ? deps.secrets.seal(remote.shippingAddress) : null;
  const row = {
    name: remote.name ?? null,
    financialStatus: remote.financialStatus ?? null,
    fulfillmentStatus: remote.fulfillmentStatus ?? null,
    customer: remote.customer ?? null,
    ...(enc ? { shippingAddressEnc: enc } : {}),
    currency: remote.currency ?? null,
    subtotal: remote.subtotal ?? null,
    total: remote.total ?? null,
    itemsCount: remote.itemsCount ?? remote.lineItems.length,
    placedAt: remote.placedAt ? new Date(remote.placedAt) : null,
    syncedAt: new Date(),
    // raw 里剥掉收货地址：加密副本在 shippingAddressEnc，raw 不落明文 PII
    raw: (() => {
      const r = { ...((remote.raw ?? remote) as Record<string, unknown>) };
      delete r.shippingAddress;
      return r;
    })(),
  };

  let orderId: string;
  let created = false;
  if (existing) {
    await deps.db.update(orders).set(row).where(eq(orders.id, existing.id));
    orderId = existing.id;
  } else {
    const [ins] = await deps.db
      .insert(orders)
      .values({
        workspaceId: store.workspaceId,
        storeId: store.id,
        remoteId: remote.remoteId,
        ...row,
      })
      .returning({ id: orders.id });
    orderId = ins!.id;
    created = true;
    await audit(deps.db, store.workspaceId, {
      actor: "system:sync",
      action: "order.synced",
      entityType: "order",
      entityId: orderId,
      payload: { remoteId: remote.remoteId, name: remote.name, total: remote.total },
    });
  }

  const existingItems = await deps.db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const byLineId = new Map(
    existingItems.filter((i) => i.remoteLineItemId).map((i) => [i.remoteLineItemId!, i]),
  );
  const seen = new Set<string>();
  for (const li of remote.lineItems) {
    seen.add(li.remoteLineItemId);
    const prev = byLineId.get(li.remoteLineItemId);
    const fields = {
      remoteVariantId: li.remoteVariantId ?? null,
      title: li.title || "未命名行项",
      sku: li.sku ?? null,
      qty: li.qty,
      unitPrice: li.unitPrice ?? null,
    };
    if (prev) {
      await deps.db.update(orderItems).set(fields).where(eq(orderItems.id, prev.id));
    } else {
      await deps.db.insert(orderItems).values({
        orderId,
        remoteLineItemId: li.remoteLineItemId,
        ...fields,
      });
    }
  }
  // 远端删掉的行项本地同步删除（仅限还没被采购引用的，保守起见保留有绑定的行）
  for (const it of existingItems) {
    if (it.remoteLineItemId && !seen.has(it.remoteLineItemId) && it.procureStatus === "none") {
      await deps.db.delete(orderItems).where(eq(orderItems.id, it.id));
    }
  }
  return { orderId, created, skipped: false };
}

// --- DTO 装配 ------------------------------------------------------------------

function toShipmentDto(s: typeof shipments.$inferSelect): Shipment {
  return {
    id: s.id,
    orderId: s.orderId,
    purchaseOrderId: s.purchaseOrderId,
    carrier: s.carrier,
    trackingNo: s.trackingNo,
    trackingUrl: s.trackingUrl,
    remoteFulfillmentId: s.remoteFulfillmentId,
    lineItems: s.lineItems ?? null,
    status: s.status,
    lastError: s.lastError,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * 订单行 → DTO。item.meta 可选地带上货源/刊登/采购链信息（列表与详情共用）。
 */
export function toOrderItemDto(
  r: OrderItemRow,
  meta?: {
    listingTitle?: string | null;
    sourceTitle?: string | null;
    offerId?: string | null;
    sourceSeller?: string | null;
    specText?: string | null;
    costCny?: number | null;
  },
): OrderItem {
  return {
    id: r.id,
    orderId: r.orderId,
    remoteLineItemId: r.remoteLineItemId,
    remoteVariantId: r.remoteVariantId,
    title: r.title,
    sku: r.sku,
    qty: r.qty,
    unitPrice: r.unitPrice,
    listingId: r.listingId,
    sourceItemId: r.sourceItemId,
    sourceSkuId: r.sourceSkuId,
    mapping: r.mapping,
    procureStatus: r.procureStatus,
    ...meta,
  };
}

/**
 * 批量装配订单 DTO（列表+详情共用）：行项、运单、脱敏地址、利润粗算、采购链。
 * 返回顺序与传入一致。地址明文绝不进 DTO。
 */
export async function hydrateOrders(
  deps: Deps,
  rows: OrderRow[],
  storeById?: Map<string, StoreRow>,
): Promise<Order[]> {
  if (!rows.length) return [];
  const db = deps.db;
  const orderIds = rows.map((r) => r.id);
  const allItems = await db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds));
  const allShips = await db
    .select()
    .from(shipments)
    .where(inArray(shipments.orderId, orderIds));
  const storeIds = [...new Set(rows.map((r) => r.storeId))];
  const storeMap =
    storeById ??
    new Map(
      (await db.select().from(stores).where(inArray(stores.id, storeIds))).map((s) => [
        s.id,
        s,
      ]),
    );

  const listingIds = [...new Set(allItems.map((i) => i.listingId).filter(Boolean))] as string[];
  const sourceIds = [...new Set(allItems.map((i) => i.sourceItemId).filter(Boolean))] as string[];
  const lMap = new Map(
    listingIds.length
      ? (await db.select().from(listings).where(inArray(listings.id, listingIds))).map((l) => [
          l.id,
          l,
        ])
      : [],
  );
  const sMap = new Map(
    sourceIds.length
      ? (await db.select().from(sourceItems).where(inArray(sourceItems.id, sourceIds))).map(
          (s) => [s.id, s],
        )
      : [],
  );

  // 采购链：行项 → 所属采购单（id+status+sourceOrderId）
  const poItemRows = await db
    .select()
    .from(purchaseOrderItems)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId))
    .where(inArray(purchaseOrderItems.orderItemId, allItems.map((i) => i.id)));
  const poByItem = new Map<string, Array<typeof purchaseOrders.$inferSelect>>();
  for (const r of poItemRows) {
    const list = poByItem.get(r.purchase_order_items.orderItemId) ?? [];
    list.push(r.purchase_orders);
    poByItem.set(r.purchase_order_items.orderItemId, list);
  }

  return rows.map((o) => {
    const items = allItems.filter((i) => i.orderId === o.id);
    const store = storeMap.get(o.storeId);
    const exchangeRate = store?.pricing?.exchangeRate;
    let costCny = 0;
    let costKnown = false;
    const itemDtos = items.map((it) => {
      const listing = it.listingId ? lMap.get(it.listingId) : undefined;
      const source = it.sourceItemId ? sMap.get(it.sourceItemId) : undefined;
      const sku = source?.skus?.find((s) => s.skuId === it.sourceSkuId);
      const itemCost = sku?.priceCny ?? null;
      if (itemCost != null) {
        costCny += itemCost * it.qty;
        costKnown = true;
      }
      return toOrderItemDto(it, {
        listingTitle: listing?.title ?? null,
        sourceTitle: source?.title ?? null,
        offerId: source?.sourceItemId ?? null,
        sourceSeller: source?.sellerName ?? null,
        specText: sku?.spec ?? null,
        costCny: itemCost,
      });
    });
    return {
      id: o.id,
      storeId: o.storeId,
      storeName: store?.name,
      remoteId: o.remoteId,
      name: o.name,
      financialStatus: o.financialStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      status: o.status,
      customer: maskCustomer(o.customer),
      shippingAddressMasked: maskAddress(openAddress(deps, o)),
      currency: o.currency,
      subtotal: o.subtotal,
      total: o.total,
      itemsCount: o.itemsCount ?? items.length,
      placedAt: o.placedAt?.toISOString() ?? null,
      syncedAt: o.syncedAt?.toISOString() ?? null,
      reviewedAt: o.reviewedAt?.toISOString() ?? null,
      items: itemDtos.map((d) => ({
        ...d,
        // 采购链引用（DTO 附加字段，不进 OrderItem 类型主体）
        purchaseOrders: poByItem.get(d.id)?.map((p) => ({
          id: p.id,
          status: p.status,
          sourceOrderId: p.sourceOrderId,
          sourceSeller: p.sourceSeller,
        })),
      })) as OrderItem[],
      shipments: allShips.filter((s) => s.orderId === o.id).map(toShipmentDto),
      profit:
        costKnown && exchangeRate && o.total != null
          ? { costCny, grossCny: o.total * exchangeRate }
          : null,
      createdAt: o.createdAt.toISOString(),
    } satisfies Order;
  });
}
