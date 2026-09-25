import type { CollectHarvest } from "@caiji/shared";

const API_BASE = "http://localhost:3000";

interface ProxyFetchReq {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

async function proxyFetch(req: ProxyFetchReq) {
  try {
    const resp = await fetch(req.url, {
      method: req.method || "GET",
      headers: req.headers,
      body: req.body,
      credentials: "include",
    });
    const body = await resp.text();
    return { ok: resp.ok, status: resp.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: String(e instanceof Error ? e.message : e) };
  }
}

/** Collect an offer by id: fetch detail HTML in-session, ship to server
 * which owns all field extraction (harvest contract). */
async function collectByOfferId(offerId: string) {
  const url = `https://detail.1688.com/offer/${offerId}.html`;
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`拉取详情失败 HTTP ${resp.status}`);
  const harvest: CollectHarvest = {
    sourceInfo: {
      itemUrl: url,
      itemId: offerId,
      site: "detail",
      source: "1688",
    },
    pageContent: await resp.text(),
    afterUrl: url,
    collectedAt: new Date().toISOString(),
  };
  const push = await fetch(`${API_BASE}/api/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(harvest),
  });
  const body = await push.json().catch(() => ({}));
  if (!push.ok) throw new Error(body?.error ?? `提交失败 HTTP ${push.status}`);
  return { product: body.product, pushed: push.ok };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "v2-collect-offer",
    title: "采集此 1688 商品",
    contexts: ["page"],
    documentUrlPatterns: ["*://*.1688.com/offer/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "v2-collect-offer" || !tab?.id) return;
  const offerId = (tab.url ?? "").match(/offer\/(\d+)/)?.[1];
  if (!offerId) return;
  const notify = (msg: string, ok = true) =>
    chrome.tabs
      .sendMessage(tab.id!, { type: "V2_TOAST", msg, ok })
      .catch(() => {});
  collectByOfferId(offerId).then(
    (r) =>
      notify(`采集成功：${(r.product?.title ?? offerId).slice(0, 50)}`),
    (e) => notify(`采集失败：${String(e?.message ?? e).slice(0, 60)}`, false),
  );
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PROXY_FETCH") {
    proxyFetch(msg.data).then(sendResponse);
    return true;
  }
  if (msg?.type === "COLLECT_BY_OFFER_ID") {
    collectByOfferId(String(msg.offerId ?? ""))
      .then((r) => sendResponse({ ok: true, data: r }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  if (msg?.type === "SITE_PING") {
    sendResponse({ ok: true, data: { name: "v2-store", version: "0.1.0" } });
    return true;
  }
});
