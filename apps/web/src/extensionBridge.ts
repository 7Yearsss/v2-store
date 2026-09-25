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
      reject(new Error("extension_timeout"));
    }, timeoutMs);
    function onMsg(ev: MessageEvent) {
      const d = ev.data;
      if (!d || d.source !== EXT_SOURCE || d.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      if (d.ok) resolve(d.result as T);
      else reject(new Error(d.error ?? "extension_error"));
    }
    window.addEventListener("message", onMsg);
    window.postMessage({ source: SITE_SOURCE, type, requestId, payload }, window.location.origin);
  });
}

/** Resolves quickly with whether the extension is installed and reachable. */
export async function pingExtension(timeoutMs = 1200): Promise<boolean> {
  try {
    await extensionCall("PING", {}, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export function collectOfferById(offerId: string) {
  return extensionCall<{ product?: { title: string }; pushed: boolean }>(
    "COLLECT_1688",
    { offerId },
    30000,
  );
}
