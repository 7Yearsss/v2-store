/**
 * Client for the extension's site-bridge: postMessage to the page, the
 * site-bridge content script relays to the background worker and replies.
 */

const SITE_SOURCE = "v2-web";
const EXT_SOURCE = "v2-ext";

export function extensionCall<T = unknown>(
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 8000,
): Promise<T> {
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("插件无响应"));
    }, timeoutMs);
    function onMsg(ev: MessageEvent) {
      const d = ev.data;
      if (!d || d.source !== EXT_SOURCE || d.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      if (d.ok) resolve(d.result as T);
      else reject(new Error(d.error ?? "插件执行失败"));
    }
    window.addEventListener("message", onMsg);
    window.postMessage({ source: SITE_SOURCE, type, requestId, payload }, window.location.origin);
  });
}

export interface ExtensionStatus {
  version: string;
  /** workspace the extension is currently authorized for, if any. */
  authorized: boolean;
}

/** null when the extension isn't installed/reachable. */
export async function pingExtension(timeoutMs = 1200): Promise<ExtensionStatus | null> {
  try {
    return await extensionCall<ExtensionStatus>("PING", {}, timeoutMs);
  } catch {
    return null;
  }
}

/** Hand the extension an API base + bearer token so it can post collections. */
export function authorizeExtension(apiBase: string, token: string) {
  return extensionCall("SET_AUTH", { apiBase, token });
}

export function collectOfferById(offerId: string) {
  return extensionCall<{ item?: { title: string }; duplicated?: boolean }>(
    "COLLECT_1688",
    { offerId },
    30000,
  );
}
