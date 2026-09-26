import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type {
  ProcureStatus,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderStatus,
} from "@caiji/shared";
import type { AppEnv, Deps } from "../context.js";
import {
  freightForwarders,
  orderItems,
  orders,
  purchaseOrderItems,
  purchaseOrders,
  sourceItems,
} from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { HttpError, notFound } from "../lib/errors.js";
import { refreshOrderStatus, toOrderItemDto } from "../lib/orders.js";
import { requireAuth } from "./auth.js";

type PoRow = typeof purchaseOrders.$inferSelect;
type FwRow = typeof freightForwarders.$inferSelect;

/** PO 状态 → 行项采购进度的单向映射（回退到 draft/none 由拆单移除处理）。 */
const ITEM_STATUS_OF: Record<PurchaseOrderStatus, ProcureStatus> = {
  draft: "queued",
  placed: "placed",
  paid: "placed",
  domestic_shipped: "shipped",
  intl_shipped: "shipped",
  done: "done",
  exception: "failed",
};

async function getPo(deps: Deps, workspaceId: string, id: string): Promise<PoRow> {
  const [row] = await deps.db
    .select()
    .from(purchaseOrders)
    .where(
      and(eq(purchaseOrders.id, id), eq(purchaseOrders.workspaceId, workspaceId)),
    );
  if (!row) throw notFound("采购单");
  return row;
}

async function toPoDto(
  deps: Deps,
  rows: PoRow[],
  fwById?: Map<string, FwRow>,
): Promise<PurchaseOrder[]> {
  if (!rows.length) return [];
  const poIds = rows.map((r) => r.id);
  const items = await deps.db
    .select()
    .from(purchaseOrderItems)
    .where(inArray(purchaseOrderItems.purchaseOrderId, poIds));
  const orderItemIds = [...new Set(items.map((i) => i.orderItemId))];
  const oItems = orderItemIds.length
    ? await deps.db
        .select({ item: orderItems, order: orders })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(inArray(orderItems.id, orderItemIds))
    : [];
  const oiById = new Map(oItems.map((r) => [r.item.id, r]));
  const srcIds = [...new Set(oItems.map((r) => r.item.sourceItemId).filter(Boolean))] as string[];
  const srcMap = new Map(
    srcIds.length
      ? (await deps.db.select().from(sourceItems).where(inArray(sourceItems.id, srcIds))).map(
          (s) => [s.id, s],
        )
      : [],
  );
  const fwIds = [...new Set(rows.map((r) => r.forwarderId).filter(Boolean))] as string[];
  const fws =
    fwById ??
    new Map(
      fwIds.length
        ? (
            await deps.db
              .select()
              .from(freightForwarders)
              .where(inArray(freightForwarders.id, fwIds))
          ).map((f) => [f.id, f])
        : [],
    );
  const toFwDto = (f: FwRow) => ({
    id: f.id,
    name: f.name,
    address: f.address,
    note: f.note,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  });
  return rows.map((p) => {
    const poItems: PurchaseOrderItem[] = items
      .filter((i) => i.purchaseOrderId === p.id)
      .map((i) => {
        const r = oiById.get(i.orderItemId);
        const src = r?.item.sourceItemId ? srcMap.get(r.item.sourceItemId) : undefined;
        const sku = src?.skus.find((s) => s.skuId === r?.item.sourceSkuId);
        return {
          purchaseOrderId: i.purchaseOrderId,
          orderItemId: i.orderItemId,
          qty: i.qty,
          unitPriceCny: i.unitPriceCny,
          orderItem: r
            ? {
                ...toOrderItemDto(r.item, {
                  sourceTitle: src?.title ?? null,
                  offerId: src?.sourceItemId ?? null,
                  specText: sku?.spec ?? null,
                }),
                orderName: r.order.name,
              }
            : null,
        };
      });
    return {
      id: p.id,
      kind: p.kind,
      sourcePlatform: p.sourcePlatform,
      sourceSeller: p.sourceSeller,
      status: p.status,
      sourceOrderId: p.sourceOrderId,
      domesticTracking: p.domesticTracking,
      intlTracking: p.intlTracking,
      forwarderId: p.forwarderId,
      forwarder: p.forwarderId ? (fws.get(p.forwarderId) ? toFwDto(fws.get(p.forwarderId)!) : null) : null,
      costTotalCny: p.costTotalCny,
      note: p.note,
      items: poItems,
      createdBy: p.createdBy,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  });
}

/** PO 状态变化 → 覆盖行项 procure_status → 刷新各订单总状态。 */
async function applyPoStatus(
  deps: Deps,
  workspaceId: string,
  po: PoRow,
  next: PurchaseOrderStatus,
  actor: string,
) {
  if (po.status === next) return;
  await deps.db
    .update(purchaseOrders)
    .set({ status: next })
    .where(eq(purchaseOrders.id, po.id));
  const items = await deps.db
    .select()
    .from(purchaseOrderItems)
    .where(eq(purchaseOrderItems.purchaseOrderId, po.id));
  if (items.length) {
    await deps.db
      .update(orderItems)
      .set({ procureStatus: ITEM_STATUS_OF[next] })
      .where(inArray(orderItems.id, items.map((i) => i.orderItemId)));
  }
  await audit(deps.db, workspaceId, {
    actor,
    action: "purchase_order.status",
    entityType: "purchase_order",
    entityId: po.id,
    payload: { from: po.status, to: next },
  });
  const orderIds = [...new Set(
    (
      await deps.db
        .select({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(inArray(orderItems.id, items.map((i) => i.orderItemId)))
    ).map((r) => r.orderId),
  )];
  for (const oid of orderIds) await refreshOrderStatus(deps, oid, actor);
}

/** 把行项从采购单摘掉（procure_status 回 none）并刷新订单。 */
async function detachItems(
  deps: Deps,
  workspaceId: string,
  poId: string,
  itemIds: string[],
  actor: string,
) {
  if (!itemIds.length) return [] as string[];
  const links = await deps.db
    .select()
    .from(purchaseOrderItems)
    .where(
      and(
        eq(purchaseOrderItems.purchaseOrderId, poId),
        inArray(purchaseOrderItems.orderItemId, itemIds),
      ),
    );
  if (!links.length) return [] as string[];
  await deps.db
    .delete(purchaseOrderItems)
    .where(
      and(
        eq(purchaseOrderItems.purchaseOrderId, poId),
        inArray(purchaseOrderItems.orderItemId, links.map((l) => l.orderItemId)),
      ),
    );
  await deps.db
    .update(orderItems)
    .set({ procureStatus: "none" })
    .where(inArray(orderItems.id, links.map((l) => l.orderItemId)));
  const orderIds = [
    ...new Set(
      (
        await deps.db
          .select({ orderId: orderItems.orderId })
          .from(orderItems)
          .where(inArray(orderItems.id, links.map((l) => l.orderItemId)))
      ).map((r) => r.orderId),
    ),
  ];
  for (const oid of orderIds) await refreshOrderStatus(deps, oid, actor);
  return links.map((l) => l.orderItemId);
}

const trackingSchema = z.array(
  z.object({
    carrier: z.string().trim().max(64).optional(),
    no: z.string().trim().min(1).max(128),
    url: z.string().trim().max(500).optional(),
  }),
);

const createSchema = z.object({
  orderItemIds: z.array(z.string().uuid()).min(1).max(200),
  forwarderId: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional(),
});

const patchSchema = z.object({
  status: z
    .enum(["draft", "placed", "paid", "domestic_shipped", "intl_shipped", "done", "exception"])
    .optional(),
  sourceOrderId: z.string().trim().max(64).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  forwarderId: z.string().uuid().nullable().optional(),
  costTotalCny: z.number().min(0).max(10_000_000).nullable().optional(),
  domesticTracking: trackingSchema.optional(),
  intlTracking: trackingSchema.optional(),
  addItemIds: z.array(z.string().uuid()).max(200).optional(),
  removeItemIds: z.array(z.string().uuid()).max(200).optional(),
});

export function purchaseOrderRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get(
    "/",
    zValidator(
      "query",
      z.object({
        status: z
          .enum([
            "draft",
            "placed",
            "paid",
            "domestic_shipped",
            "intl_shipped",
            "done",
            "exception",
          ])
          .optional(),
      }),
    ),
    async (c) => {
      const deps = c.var.deps;
      const { status } = c.req.valid("query");
      const rows = await deps.db
        .select()
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.workspaceId, c.var.auth.workspaceId),
            status ? eq(purchaseOrders.status, status) : undefined,
          ),
        )
        .orderBy(desc(purchaseOrders.createdAt));
      return c.json({ items: await toPoDto(deps, rows), total: rows.length });
    },
  );

  r.get("/:id", async (c) => {
    const deps = c.var.deps;
    const po = await getPo(deps, c.var.auth.workspaceId, c.req.param("id"));
    const [dto] = await toPoDto(deps, [po]);
    return c.json(dto);
  });

  /** 勾选订单行项生成采购单：按货源供应商自动拆分，一供应商一单。 */
  r.post("/", zValidator("json", createSchema), async (c) => {
    const deps = c.var.deps;
    const { workspaceId, userId } = c.var.auth;
    const { orderItemIds, forwarderId, note } = c.req.valid("json");
    const rows = await deps.db
      .select({ item: orderItems, order: orders })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          inArray(orderItems.id, orderItemIds),
          eq(orders.workspaceId, workspaceId),
        ),
      );
    if (!rows.length) throw new HttpError(400, "没有可采购的订单行项");
    const bad = rows.filter((r) => !r.item.sourceItemId);
    if (bad.length) {
      throw new HttpError(422, `${bad.length} 个行项未绑定货源，先映射`, "unmatched_items");
    }
    // 已在未完成采购单里的行项拒绝重复入单
    const existing = await deps.db
      .select()
      .from(purchaseOrderItems)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId))
      .where(
        and(
          inArray(purchaseOrderItems.orderItemId, orderItemIds),
          inArray(purchaseOrders.status, [
            "draft",
            "placed",
            "paid",
            "domestic_shipped",
            "intl_shipped",
          ]),
        ),
      );
    if (existing.length) {
      throw new HttpError(
        409,
        `${existing.length} 个行项已在采购单中，请先在原单里移除`,
        "already_in_po",
      );
    }
    const srcIds = [...new Set(rows.map((r) => r.item.sourceItemId))] as string[];
    const srcMap = new Map(
      (await deps.db.select().from(sourceItems).where(inArray(sourceItems.id, srcIds))).map(
        (s) => [s.id, s],
      ),
    );
    // 按供应商拆单：同 sellerName 的行项进同一张 PO
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const seller = srcMap.get(r.item.sourceItemId!)?.sellerName ?? "";
      groups.set(seller, [...(groups.get(seller) ?? []), r]);
    }
    const created: PurchaseOrder[] = [];
    const touchedOrders = new Set<string>();
    for (const [seller, group] of groups) {
      const [po] = await deps.db
        .insert(purchaseOrders)
        .values({
          workspaceId,
          kind: "manual",
          sourcePlatform: "1688",
          sourceSeller: seller || null,
          forwarderId: forwarderId ?? null,
          note: note ?? null,
          createdBy: userId,
        })
        .returning();
      for (const { item } of group) {
        const sku = srcMap
          .get(item.sourceItemId!)
          ?.skus.find((s) => s.skuId === item.sourceSkuId);
        await deps.db.insert(purchaseOrderItems).values({
          purchaseOrderId: po!.id,
          orderItemId: item.id,
          qty: item.qty,
          unitPriceCny: sku?.priceCny ?? null,
        });
        await deps.db
          .update(orderItems)
          .set({ procureStatus: "queued" })
          .where(eq(orderItems.id, item.id));
        touchedOrders.add(item.orderId);
      }
      await audit(deps.db, workspaceId, {
        actor: `user:${userId}`,
        action: "purchase_order.created",
        entityType: "purchase_order",
        entityId: po!.id,
        payload: { items: group.length, seller },
      });
      created.push((await toPoDto(deps, [po!]))[0]!);
    }
    for (const oid of touchedOrders) {
      await refreshOrderStatus(deps, oid, `user:${userId}`);
    }
    return c.json({ items: created, total: created.length }, 201);
  });

  r.patch("/:id", zValidator("json", patchSchema), async (c) => {
    const deps = c.var.deps;
    const { workspaceId, userId } = c.var.auth;
    const po = await getPo(deps, workspaceId, c.req.param("id"));
    const body = c.req.valid("json");
    const actor = `user:${userId}`;

    if (body.removeItemIds?.length) {
      await detachItems(deps, workspaceId, po.id, body.removeItemIds, actor);
    }
    if (body.addItemIds?.length) {
      // 合并入单：行项必须已绑货源且不在其他未完成 PO 里
      const rows = await deps.db
        .select({ item: orderItems, order: orders })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
          and(
            inArray(orderItems.id, body.addItemIds),
            eq(orders.workspaceId, workspaceId),
          ),
        );
      const conflict = await deps.db
        .select({ orderItemId: purchaseOrderItems.orderItemId })
        .from(purchaseOrderItems)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId))
        .where(
          and(
            inArray(purchaseOrderItems.orderItemId, body.addItemIds),
            ne(purchaseOrders.id, po.id),
            inArray(purchaseOrders.status, [
              "draft",
              "placed",
              "paid",
              "domestic_shipped",
              "intl_shipped",
            ]),
          ),
        );
      if (conflict.length) {
        throw new HttpError(409, "部分行项已在其他采购单中", "already_in_po");
      }
      const srcIds = [...new Set(rows.map((r) => r.item.sourceItemId).filter(Boolean))] as string[];
      const srcMap = new Map(
        srcIds.length
          ? (await deps.db.select().from(sourceItems).where(inArray(sourceItems.id, srcIds))).map(
              (s) => [s.id, s],
            )
          : [],
      );
      for (const { item } of rows) {
        const sku = srcMap.get(item.sourceItemId!)?.skus.find(
          (s) => s.skuId === item.sourceSkuId,
        );
        await deps.db
          .insert(purchaseOrderItems)
          .values({
            purchaseOrderId: po.id,
            orderItemId: item.id,
            qty: item.qty,
            unitPriceCny: sku?.priceCny ?? null,
          })
          .onConflictDoNothing();
        await deps.db
          .update(orderItems)
          .set({ procureStatus: ITEM_STATUS_OF[po.status] })
          .where(eq(orderItems.id, item.id));
        await refreshOrderStatus(deps, item.orderId, actor);
      }
    }

    const patch: Partial<PoRow> = {};
    if (body.sourceOrderId !== undefined) patch.sourceOrderId = body.sourceOrderId;
    if (body.note !== undefined) patch.note = body.note;
    if (body.forwarderId !== undefined) {
      if (body.forwarderId) {
        const [fw] = await deps.db
          .select({ id: freightForwarders.id })
          .from(freightForwarders)
          .where(
            and(
              eq(freightForwarders.id, body.forwarderId),
              eq(freightForwarders.workspaceId, workspaceId),
            ),
          );
        if (!fw) throw notFound("货代");
      }
      patch.forwarderId = body.forwarderId;
    }
    if (body.costTotalCny !== undefined) patch.costTotalCny = body.costTotalCny;
    if (body.domesticTracking !== undefined) patch.domesticTracking = body.domesticTracking;
    if (body.intlTracking !== undefined) patch.intlTracking = body.intlTracking;
    if (Object.keys(patch).length) {
      await deps.db.update(purchaseOrders).set(patch).where(eq(purchaseOrders.id, po.id));
    }
    if (body.status) {
      await applyPoStatus(deps, workspaceId, { ...po, ...patch }, body.status, actor);
    }
    const [dto] = await toPoDto(deps, [await getPo(deps, workspaceId, po.id)]);
    return c.json(dto);
  });

  r.delete("/:id", async (c) => {
    const deps = c.var.deps;
    const { workspaceId, userId } = c.var.auth;
    const po = await getPo(deps, workspaceId, c.req.param("id"));
    if (po.status !== "draft") {
      throw new HttpError(409, "只有草稿采购单可删除；已下单的请标记异常", "po_not_draft");
    }
    const items = await deps.db
      .select()
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, po.id));
    await detachItems(
      deps,
      workspaceId,
      po.id,
      items.map((i) => i.orderItemId),
      `user:${userId}`,
    );
    await deps.db.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    await audit(deps.db, workspaceId, {
      actor: `user:${userId}`,
      action: "purchase_order.deleted",
      entityType: "purchase_order",
      entityId: po.id,
    });
    return c.json({ ok: true });
  });

  return r;
}
