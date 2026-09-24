/**
 * Isolated-world bridge on our own web app origin (localhost:5173 dev).
 * The web app calls window.postMessage({source:"v2-web", type, requestId, payload});
 * we forward to the background worker and post back {source:"v2-ext"}.
 */

const SITE_SOURCE = "v2-web";
const EXT_SOURCE = "v2-ext";

const HANDLERS: Record<string, string> = {
  PING: "SITE_PING",
  COLLECT_1688: "COLLECT_BY_OFFER_ID",
};

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const msg = ev.data;
  if (!msg || msg.source !== SITE_SOURCE || typeof msg.requestId !== "string") return;
  const bgType = HANDLERS[msg.type];
  if (!bgType) return;
  chrome.runtime.sendMessage(
    { type: bgType, ...(msg.payload ?? {}) },
    (resp) => {
      const err = chrome.runtime.lastError;
      window.postMessage(
        {
          source: EXT_SOURCE,
          requestId: msg.requestId,
          ok: err ? false : Boolean(resp?.ok),
          result: resp?.data,
          error: err?.message ?? resp?.error,
        },
        window.location.origin,
      );
    },
  );
});
