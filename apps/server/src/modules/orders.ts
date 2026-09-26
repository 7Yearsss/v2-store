import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { OrderStatus, ProcurePayload } from "@caiji/shared";
import type { AppEnv, Deps } from "../context.js";
import {
  freightForwarders,
  listings,
  orderItems,
  orders,
  purchaseOrderItems,
  purchaseOrders,
  shipments,
  sourceItems,
  stores,
} from "../db/schema.js";
import { audit, listAudits } from "../lib/audit.js";
import { HttpError, notFound } from "../lib/errors.js";
import {
  hydrateOrders,
  openAddress,
  refreshOrderStatus,
  type OrderRow,
} from "../lib/orders.js";
import {
  enqueueFulfillPush,
  enqueueOrderSync,
} from "../jobs/handlers.js";
import { requireAuth } from "./auth.js";

const listQuery = z.object({
  status: z
    .enum([
      "new",
      "to_procure",
      "procuring",
      "to_ship",
      "shipped",
      "done",
      "cancelled",
      "exception",
    ])
    .optional(),
  storeId: z.string().uuid().optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

async function getOrder(deps: Deps, workspaceId: string, id: string): Promise<OrderRow> {
  const [row] = await deps.db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.workspaceId, workspaceId)));
  if (!row) throw notFound("订单");
  return row;
}

export function orderRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", zValidator("query", listQuery), async (c) => {
    const deps = c.var.deps;
    const { status, storeId, q, page, pageSize } = c.req.valid("query");
    const where = and(
      eq(orders.workspaceId, c.var.auth.workspaceId),
      status ? eq(orders.status, status) : undefined,
      storeId ? eq(orders.storeId, storeId) : undefined,
      q
        ? or(ilike(orders.name, `%${q}%`), ilike(orders.remoteId, `%${q}%`))
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      deps.db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.placedAt), desc(orders.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      deps.db.select({ n: count() }).from(orders).where(where),
    ]);
    return c.json({ items: await hydrateOrders(deps, rows), total: total?.n ?? 0 });
  });

  r.get("/counts", async (c) => {
    const rows = await c.var.deps.db
      .select({ status: orders.status, n: count() })
      .from(orders)
      .where(eq(orders.workspaceId, c.var.auth.workspaceId))
      .groupBy(orders.status);
    return c.json(Object.fromEntries(rows.map((x) => [x.status, x.n])) as Record<OrderStatus, number>);
  });

  r.get("/:id", async (c) => {
    const deps = c.var.deps;
    const row = await getOrder(deps, c.var.auth.workspaceId, c.req.param("id"));
    const [dto] = await hydrateOrders(deps, [row]);
    const audits = await listAudits(deps.db, c.var.auth.workspaceId, "order", row.id);
    return c.json({ order: dto, audits });
  });

  /**
   * 收货地址明文单独端点：列表/详情只给脱敏摘要，复制动作走这里并留痕。
   */
  r.get("/:id/address", async (c) => {
    const deps = c.var.deps;
    const row = await getOrder(deps, c.var.auth.workspaceId, c.req.param("id"));
    const address = openAddress(deps, row);
    if (!address) throw new HttpError(404, "订单没有收货地址", "no_address");
    await audit(deps.db, c.var.auth.workspaceId, {
      actor: `user:${c.var.auth.userId}`,
      action: "order.address_reveal",
      entityType: "order",
      entityId: row.id,
      payload: { name: row.name },
    });
    return c.json({ address, customer: row.customer });
  });

  /** 人工审核闸：new → to_procure。 */
  r.post("/:id/review", async (c) => {
    const deps = c.var.deps;
    const row = await getOrder(deps, c.var.auth.workspaceId, c.req.param("id"));
    if (!row.reviewedAt) {
      await deps.db
        .update(orders)
        .set({ reviewedAt: new Date() })
        .where(eq(orders.id, row.id));
      await audit(deps.db, c.var.auth.workspaceId, {
        actor: `user:${c.var.auth.userId}`,
        action: "order.reviewed",
        entityType: "order",
        entityId: row.id,
        payload: { name: row.name },
      });
      await refreshOrderStatus(deps, row.id, `user:${c.var.auth.userId}`);
    }
    const [dto] = await hydrateOrders(deps, [
      (await getOrder(deps, c.var.auth.workspaceId, row.id)),
    ]);
    return c.json(dto);
  });

  /** 人工绑定货源：行项 → 采集箱条目 + specId。 */
  r.post(
    "/:id/items/:itemId/bind",
    zValidator(
      "json",
      z.object({
        sourceItemId: z.string().uuid(),
        sourceSkuId: z.string().max(255).optional(),
      }),
    ),
    async (c) => {
      const deps = c.var.deps;
      const { workspaceId, userId } = c.var.auth;
      const order = await getOrder(deps, workspaceId, c.req.param("id"));
      const body = c.req.valid("json");
      const [item] = await deps.db
        .select()
        .from(orderItems)
        .where(
          and(eq(orderItems.id, c.req.param("itemId")), eq(orderItems.orderId, order.id)),
        );
      if (!item) throw notFound("订单行项");
      const [src] = await deps.db
        .select()
        .from(sourceItems)
        .where(
          and(
            eq(sourceItems.id, body.sourceItemId),
            eq(sourceItems.workspaceId, workspaceId),
          ),
        );
      if (!src) throw notFound("货源");
      if (body.sourceSkuId && !src.skus.some((s) => s.skuId === body.sourceSkuId)) {
        throw new HttpError(400, "规格不存在于该货源");
      }
      const [listing] = await deps.db
        .select({ id: listings.id })
        .from(listings)
        .where(
          and(
            eq(listings.storeId, order.storeId),
            eq(listings.sourceItemId, src.id),
          ),
        )
        .limit(1);
      await deps.db
        .update(orderItems)
        .set({
          listingId: listing?.id ?? null,
          sourceItemId: src.id,
          sourceSkuId: body.sourceSkuId ?? null,
          mapping: body.sourceSkuId ? "matched" : "partial",
        })
        .where(eq(orderItems.id, item.id));
      await audit(deps.db, workspaceId, {
        actor: `user:${userId}`,
        action: "order.item_bound",
        entityType: "order",
        entityId: order.id,
        payload: { orderItemId: item.id, sourceItemId: src.id, sourceSkuId: body.sourceSkuId },
      });
      await refreshOrderStatus(deps, order.id, `user:${userId}`);
      const [dto] = await hydrateOrders(deps, [
        await getOrder(deps, workspaceId, order.id),
      ]);
      return c.json(dto);
    },
  );

  /**
   * 去采购：返回插件采购卡的负载（offerId/规格/数量/收货地址）。
   * 不创建采购单、不改状态——采购单在用户「标记已下单」或手工勾选生成时落地。
   */
  r.post("/:id/procure", async (c) => {
    const deps = c.var.deps;
    const order = await getOrder(deps, c.var.auth.workspaceId, c.req.param("id"));
    const items = await deps.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    const srcIds = [...new Set(items.map((i) => i.sourceItemId).filter(Boolean))] as string[];
    const srcs = srcIds.length
      ? await deps.db.select().from(sourceItems).where(inArray(sourceItems.id, srcIds))
      : [];
    const srcMap = new Map(srcs.map((s) => [s.id, s]));
    const offers: ProcurePayload["offers"] = [];
    for (const it of items) {
      const src = it.sourceItemId ? srcMap.get(it.sourceItemId) : undefined;
      if (!src?.sourceItemId) continue;
      const sku = src.skus.find((s) => s.skuId === it.sourceSkuId);
      offers.push({
        offerId: src.sourceItemId,
        sourceItemId: src.id,
        title: src.title,
        image: src.images[0] ?? null,
        specText: sku?.spec ?? null,
        qty: it.qty,
        unitPriceCny: sku?.priceCny ?? null,
      });
    }
    if (!offers.length) {
      throw new HttpError(422, "没有已匹配货源的行项，先绑定货源", "no_matched_items");
    }
    // 采购收货地址：优先已关联采购单的货代地址，否则买家地址
    const [po] = await deps.db
      .select({ forwarderId: purchaseOrders.forwarderId })
      .from(purchaseOrderItems)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId))
      .where(inArray(purchaseOrderItems.orderItemId, items.map((i) => i.id)))
      .limit(1);
    let address = openAddress(deps, order);
    if (po?.forwarderId) {
      const [fw] = await deps.db
        .select()
        .from(freightForwarders)
        .where(eq(freightForwarders.id, po.forwarderId));
      if (fw) address = fw.address;
    }
    return c.json({
      orderId: order.id,
      orderName: order.name,
      offers,
      address,
    } satisfies ProcurePayload);
  });

  /**
   * 插件「标记已下单」回填：找到（或按该 offer 的行项创建）草稿/已下单采购单，
   * 写 sourceOrderId 并推进到 placed。行项 procure_status → placed。
   */
  r.post(
    "/:id/procure-confirm",
    zValidator(
      "json",
      z.object({
        offerId: z.string().max(64).optional(),
        sourceOrderId: z.string().trim().min(1).max(64),
      }),
    ),
    async (c) => {
      const deps = c.var.deps;
      const { workspaceId, userId } = c.var.auth;
      const order = await getOrder(deps, workspaceId, c.req.param("id"));
      const { offerId, sourceOrderId } = c.req.valid("json");
      const items = await deps.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      const srcIds = [...new Set(items.map((i) => i.sourceItemId).filter(Boolean))] as string[];
      const srcs = srcIds.length
        ? await deps.db.select().from(sourceItems).where(inArray(sourceItems.id, srcIds))
        : [];
      // 本次下单覆盖的行项：给了 offerId 就只算那个货源的；没给算全部已匹配行
      const covered = items.filter((i) => {
        const src = srcs.find((s) => s.id === i.sourceItemId);
        return src && (!offerId || src.sourceItemId === offerId);
      });
      if (!covered.length) throw new HttpError(422, "该订单没有对应货源的行项", "no_items");
      const src = srcs.find((s) => s.id === covered[0]!.sourceItemId)!;

      // 找已含这些行项、且未完结的采购单；没有就建一张 source_order
      const existingLinks = await deps.db
        .select()
        .from(purchaseOrderItems)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId))
        .where(
          and(
            inArray(purchaseOrderItems.orderItemId, covered.map((i) => i.id)),
            inArray(purchaseOrders.status, ["draft", "placed", "paid"]),
          ),
        );
      let poId = existingLinks[0]?.purchase_orders.id;
      if (!poId) {
        const [created] = await deps.db
          .insert(purchaseOrders)
          .values({
            workspaceId,
            kind: "source_order",
            sourcePlatform: src.sourcePlatform,
            sourceSeller: src.sellerName,
            status: "draft",
            createdBy: userId,
          })
          .returning({ id: purchaseOrders.id });
        poId = created!.id;
        for (const it of covered) {
          const sku = srcs
            .find((s) => s.id === it.sourceItemId)
            ?.skus.find((s) => s.skuId === it.sourceSkuId);
          await deps.db.insert(purchaseOrderItems).values({
            purchaseOrderId: poId,
            orderItemId: it.id,
            qty: it.qty,
            unitPriceCny: sku?.priceCny ?? null,
          });
        }
      }
      await deps.db
        .update(purchaseOrders)
        .set({
          sourceOrderId,
          status: "placed",
        })
        .where(eq(purchaseOrders.id, poId));
      await deps.db
        .update(orderItems)
        .set({ procureStatus: "placed" })
        .where(inArray(orderItems.id, covered.map((i) => i.id)));
      await audit(deps.db, workspaceId, {
        actor: `user:${userId}`,
        action: "purchase_order.placed",
        entityType: "purchase_order",
        entityId: poId,
        payload: { orderId: order.id, sourceOrderId, via: "extension" },
      });
      await refreshOrderStatus(deps, order.id, `user:${userId}`);
      const [po] = await deps.db
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, poId));
      return c.json({ purchaseOrderId: poId, status: po!.status });
    },
  );

  /** 录运单 → 建 shipment 并入队 fulfill.push。 */
  r.post(
    "/:id/fulfill",
    zValidator(
      "json",
      z.object({
        trackingNo: z.string().trim().min(1).max(128),
        carrier: z.string().trim().max(64).optional(),
        trackingUrl: z.string().trim().max(500).optional(),
        /** 重推一条失败/待推的 shipment；缺省新建。 */
        shipmentId: z.string().uuid().optional(),
        /** 只发这些行项（部分发货）；缺省 = 全部剩余行。 */
        remoteLineItemIds: z.array(z.string().max(128)).max(100).optional(),
      }),
    ),
    async (c) => {
      const deps = c.var.deps;
      const { workspaceId, userId } = c.var.auth;
      const order = await getOrder(deps, workspaceId, c.req.param("id"));
      const body = c.req.valid("json");
      let shipmentId = body.shipmentId;
      if (shipmentId) {
        const [s] = await deps.db
          .select()
          .from(shipments)
          .where(
            and(eq(shipments.id, shipmentId), eq(shipments.orderId, order.id)),
          );
        if (!s) throw notFound("运单");
        await deps.db
          .update(shipments)
          .set({
            carrier: body.carrier ?? s.carrier,
            trackingNo: body.trackingNo,
            trackingUrl: body.trackingUrl ?? s.trackingUrl,
            status: "pending",
            lastError: null,
          })
          .where(eq(shipments.id, shipmentId));
      } else {
        const [ins] = await deps.db
          .insert(shipments)
          .values({
            workspaceId,
            orderId: order.id,
            carrier: body.carrier ?? null,
            trackingNo: body.trackingNo,
            trackingUrl: body.trackingUrl ?? null,
          })
          .returning({ id: shipments.id });
        shipmentId = ins!.id;
      }
      await enqueueFulfillPush(deps.db, shipmentId, workspaceId);
      await audit(deps.db, workspaceId, {
        actor: `user:${userId}`,
        action: "order.fulfill_queued",
        entityType: "order",
        entityId: order.id,
        payload: { shipmentId, trackingNo: body.trackingNo },
      });
      const [dto] = await hydrateOrders(deps, [await getOrder(deps, workspaceId, order.id)]);
      return c.json(dto);
    },
  );

  /** 手动补拉这一单（webhook 没店外部署时，或排查用）。 */
  r.post("/:id/sync-now", async (c) => {
    const deps = c.var.deps;
    const order = await getOrder(deps, c.var.auth.workspaceId, c.req.param("id"));
    await enqueueOrderSync(deps.db, order.storeId, c.var.auth.workspaceId, order.remoteId);
    return c.json({ queued: true });
  });

  /** 店级手动全量同步（轮询兜底入口）。 */
  r.post("/sync", zValidator("json", z.object({ storeId: z.string().uuid() })), async (c) => {
    const deps = c.var.deps;
    const { storeId } = c.req.valid("json");
    const [store] = await deps.db
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.id, storeId), eq(stores.workspaceId, c.var.auth.workspaceId)));
    if (!store) throw notFound("店铺");
    await enqueueOrderSync(deps.db, store.id, c.var.auth.workspaceId);
    return c.json({ queued: true });
  });

  return r;
}
