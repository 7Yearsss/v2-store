import type { CollectHarvest } from "@caiji/shared";

/** Content-script → background RPC. The background owns auth + the API base. */
export type BgMessage =
  | { type: "SUBMIT_HARVEST"; harvest: CollectHarvest }
  | { type: "CHECK_COLLECTED"; items: Array<{ itemUrl?: string; itemId?: string }> }
  | { type: "COLLECT_BY_OFFER_ID"; offerId: string }
  | { type: "GET_STATUS" };

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
  item: { id: string; title: string; images: string[] };
  duplicated: boolean;
}
