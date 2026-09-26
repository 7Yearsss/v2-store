import type { CollectHarvest, ShippingAddress } from "@caiji/shared";

/** 待确认队列条目：点采集先 stage 到这里，用户在面板勾选提交后才真正入库。 */
export interface PendingItem {
  offerId: string;
  title: string;
  image?: string;
  price?: string;
  /** 详情页采集时已解析的完整数据——提交时直接入箱，不用重拉页面 */
  harvest?: CollectHarvest;
}

/** 一条待采购货源行：web 侧「去采购」下发，按 (orderId, offerId) 去重存 background。 */
export interface ProcureOfferTask {
  orderId: string;
  orderName?: string | null;
  offerId: string;
  /** 服务端 source_items.id —— 回传时服务端用来定位行项 */
  sourceItemId?: string;
  title: string;
  image?: string | null;
  specText?: string | null;
  qty: number;
  unitPriceCny?: number | null;
  address?: ShippingAddress | null;
}

/** Content-script → background RPC. The background owns auth + the API base. */
export type BgMessage =
  | { type: "SUBMIT_HARVEST"; harvest: CollectHarvest }
  | { type: "CHECK_COLLECTED"; items: Array<{ itemUrl?: string; itemId?: string }> }
  | { type: "COLLECT_BY_OFFER_ID"; offerId: string }
  | { type: "STAGE_COLLECT"; item: PendingItem }
  | { type: "GET_PENDING" }
  | { type: "UNSTAGE"; offerId: string }
  | { type: "CLEAR_PENDING" }
  | { type: "SUBMIT_PENDING"; offerIds: string[] }
  | { type: "FETCH_DESC_IMAGES"; url: string }
  | { type: "PROCURE_1688"; orderId: string; orderName?: string | null; offers: ProcureOfferTask[]; address?: ShippingAddress | null }
  | { type: "GET_PROCURE"; offerId: string }
  | { type: "GET_PROCURE_LIST" }
  | { type: "PROCURE_PLACED"; orderId: string; offerId?: string; sourceOrderId: string }
  | { type: "GET_STATUS" };

/** background → content script 广播：待采购任务变化。 */
export interface ProcureChanged {
  type: "V2_PROCURE_CHANGED";
}

/** background → content script 广播：待确认队列变化（stage/unstage/submit 后）。 */
export interface PendingChanged {
  type: "V2_PENDING_CHANGED";
  /** 当前仍在队列里的 offerId 列表 */
  stagedIds: string[];
  /** 刚提交成功的 offerId 列表（卡片可标已采集） */
  okIds: string[];
}

export interface SubmitPendingResult {
  results: Array<{
    offerId: string;
    ok: boolean;
    duplicated?: boolean;
    title?: string;
    image?: string;
    error?: string;
  }>;
}

export interface BgResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function sendToBackground<T = unknown>(msg: BgMessage): Promise<T> {
  let resp: BgResponse<T> | undefined;
  try {
    resp = await chrome.runtime.sendMessage(msg);
  } catch (e) {
    throw new Error("插件后台未响应，请刷新页面或重新加载插件");
  }
  if (!resp) throw new Error("插件后台未响应，请刷新页面或重新加载插件");
  if (!resp.ok) throw new Error(resp.error ?? "请求失败");
  return resp.data as T;
}

export interface SubmitResult {
  item: { id: string; title: string; images: string[]; descImages?: string[] };
  duplicated: boolean;
}
