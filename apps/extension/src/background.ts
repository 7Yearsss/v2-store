import type { CollectHarvest } from "@caiji/shared";
import {
  descImagesFromHtml,
  descUrlFromData,
  findInitData,
  productOnlyData,
} from "@caiji/shared";
import type { BgMessage, BgResponse, SubmitResult } from "./lib/messages";

const VERSION = chrome.runtime.getManifest().version;

interface ExtAuth {
  /** web app origin; the API lives at `${apiBase}/api`. */
  apiBase: string;
  token: string;
}

async function getAuth(): Promise<ExtAuth | null> {
  const { auth } = await chrome.storage.local.get("auth");
  return (auth as ExtAuth | undefined) ?? null;
}

/** First dashboard origin the build trusts (site-bridge content-script match). */
function defaultAppOrigin(): string | null {
  const cs = chrome.runtime
    .getManifest()
    .content_scripts?.find((c) => c.js?.includes("site-bridge.js"));
  const pattern = cs?.matches?.[0];
  return pattern ? pattern.replace(/\/\*$/, "") : null;
}

class NotAuthorizedError extends Error {
  constructor(message = "插件未授权：请打开工作台，点击右上角「授权插件」") {
    super(message);
  }
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const auth = await getAuth();
  if (!auth) throw new NotAuthorizedError();
  const res = await fetch(`${auth.apiBase}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    await chrome.storage.local.remove("auth");
    throw new NotAuthorizedError("插件授权已失效，请在工作台重新「授权插件」");
  }
  if (!res.ok) throw new Error(data?.error ?? `服务端错误 HTTP ${res.status}`);
  return data as T;
}

/**
 * Copy a collected item's images into our storage: download in the user's
 * browser (reliable access to the source CDN from their network), upload
 * the bytes to our API. Best-effort — the server fetches anything missed.
 */
async function uploadImages(urls: string[]) {
  const auth = await getAuth();
  if (!auth || !urls.length) return;
  const { missing } = await api<{ missing: string[] }>("/media/missing", { urls });
  const queue = [...missing];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        const img = await fetch(url, { credentials: "omit" });
        if (!img.ok) continue;
        const body = await img.arrayBuffer();
        await fetch(`${auth.apiBase}/api/media/upload?sourceUrl=${encodeURIComponent(url)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Content-Type": img.headers.get("content-type") ?? "application/octet-stream",
          },
          body,
        });
      } catch {
        /* left for the server-side fallback */
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

async function submitHarvest(harvest: CollectHarvest) {
  const result = await api<SubmitResult>("/collect", harvest);
  // don't make the user wait on image copies
  uploadImages([...(result.item.images ?? []), ...(result.item.descImages ?? [])]).catch(() => {});
  return result;
}

/** Collect an offer by id: fetch detail HTML in the user's 1688 session, ship
 * it to the server which owns all field extraction (harvest contract). */
async function collectByOfferId(offerId: string) {
  if (!/^\d+$/.test(offerId)) throw new Error("offerId 格式错误");
  const url = `https://detail.1688.com/offer/${offerId}.html`;
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`拉取详情失败 HTTP ${resp.status}`);
  if (/login\.(taobao|1688)\.com|punish/.test(resp.url)) {
    throw new Error("1688 要求登录或安全验证，请先在浏览器打开 1688 完成验证");
  }
  const html = await resp.text();
  // Parse here and ship only product data; raw HTML (which also holds the
  // viewer's 1688 account) goes up only when parsing failed.
  const data = findInitData(html);
  if (!data && /punish|verifycode|滑块验证/.test(html)) {
    throw new Error("1688 触发了安全验证，请在浏览器里打开任一 1688 商品页完成滑块后重试");
  }
  // 详情图只活在 DOM/ descUrl 接口里——后台再拉一次 descUrl HTML 解析。
  const descUrl = data ? descUrlFromData(data) : undefined;
  const descImages = descUrl ? await fetchDescImages(descUrl).catch(() => []) : [];
  return submitHarvest({
    sourceInfo: { itemUrl: url, itemId: offerId, site: "detail", source: "1688" },
    pageContent: data ? undefined : html,
    afterUrl: resp.url,
    productExtInfo: data
      ? { initData: productOnlyData(data), ...(descImages.length ? { descImages } : {}) }
      : undefined,
    collectedAt: new Date().toISOString(),
  });
}

/** 拉详情区 HTML（1688 descUrl）并解析长图；同域请求带页面会话。 */
async function fetchDescImages(descUrl: string): Promise<string[]> {
  if (!/^https?:\/\/[^/]*1688\.com\//.test(descUrl)) return [];
  const resp = await fetch(descUrl, { credentials: "include" });
  if (!resp.ok) return [];
  const html = await resp.text();
  return descImagesFromHtml(html).slice(0, 30);
}

function reply<T>(p: Promise<T>, sendResponse: (r: BgResponse<T>) => void) {
  p.then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
  );
  return true; // async response
}

// --- messages from our own content scripts on source sites -----------------

chrome.runtime.onMessage.addListener((msg: BgMessage | { type: string; [k: string]: any }, sender, sendResponse) => {
  switch (msg?.type) {
    case "SUBMIT_HARVEST":
      return reply(submitHarvest((msg as any).harvest), sendResponse);
    case "CHECK_COLLECTED":
      return reply(api("/collect/check", { items: (msg as any).items }), sendResponse);
    case "FETCH_DESC_IMAGES":
      return reply(fetchDescImages(String((msg as any).url ?? "")).then((images) => ({ images })), sendResponse);
    case "COLLECT_BY_OFFER_ID":
      return reply(collectByOfferId(String((msg as any).offerId ?? "")), sendResponse);
    case "GET_STATUS":
      return reply(
        getAuth().then((auth) => ({
          authorized: !!auth,
          // before authorization, point at the first trusted dashboard origin
          appUrl: auth?.apiBase ?? defaultAppOrigin(),
        })),
        sendResponse,
      );

    // --- site-bridge (our web app origin only; see manifest matches) -------
    case "SITE_PING":
      return reply(
        getAuth().then((auth) => ({ version: VERSION, authorized: !!auth })),
        sendResponse,
      );
    case "SITE_SET_AUTH": {
      const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
      const { apiBase, token } = msg as any;
      // only accept credentials for the origin that is handing them over
      if (!token || typeof token !== "string" || apiBase !== origin) {
        sendResponse({ ok: false, error: "授权来源不匹配" });
        return false;
      }
      return reply(
        chrome.storage.local.set({ auth: { apiBase, token } satisfies ExtAuth }).then(() => ({ ok: true })),
        sendResponse,
      );
    }
  }
  return false;
});

// --- context menu -----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "v2-collect-offer",
    title: "采集此 1688 商品",
    contexts: ["page"],
    documentUrlPatterns: ["*://*.1688.com/offer/*", "*://*.1688.com//offer/*", "*://*.1688.com/detail/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "v2-collect-offer" || !tab?.id) return;
  const offerId = (tab.url ?? "").match(/offer\/(\d+)/)?.[1];
  if (!offerId) return;
  const notify = (msg: string, ok = true) =>
    chrome.tabs.sendMessage(tab.id!, { type: "V2_TOAST", msg, ok }).catch(() => {});
  collectByOfferId(offerId).then(
    (r) => notify(`${r.duplicated ? "已更新" : "采集成功"}：${r.item.title.slice(0, 40)}`),
    (e) => notify(`采集失败：${String(e?.message ?? e).slice(0, 80)}`, false),
  );
});
