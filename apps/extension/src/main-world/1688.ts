import {
  findInitData,
  findOfferList,
  normalizeOffer,
  tryParseJson,
} from "../lib/offer1688";

/**
 * Runs in the page's MAIN world (manifest world:"MAIN", document_start) so it
 * can read page globals (window.__INIT_DATA / context) and hook fetch/XHR to
 * sniff mtop offerList responses for whole-shop collection.
 * Isolated world talks to us via `v2:1688:req` / `v2:1688:res` CustomEvents.
 */

declare const window: any;
declare const document: any;

const CACHE_KEY = "__V2_1688_SHOP_CACHE__";
const SNIFF_API = "mtop.alibaba.alisite.cbu.server.moduleasyncservice";

if (!window.__v2_1688_collect_main_ready) {
  window.__v2_1688_collect_main_ready = true;
  window[CACHE_KEY] = { offerList: [], fetchedAt: 0 };

  function cacheOfferList(list: any[] | null) {
    if (!Array.isArray(list) || !list.length) return false;
    window[CACHE_KEY] = { offerList: list, fetchedAt: Date.now() };
    return true;
  }

  function sniffResponse(url: string, text: string) {
    const isTarget =
      url.toLowerCase().includes(SNIFF_API) ||
      url.toLowerCase().includes("moduleasyncservice") ||
      (url.toLowerCase().includes("mtop.alibaba.alisite") &&
        url.toLowerCase().includes("offer"));
    if (!isTarget && !(text.includes("offerList") && text.includes("offerImages"))) {
      return;
    }
    const parsed = tryParseJson(text);
    if (parsed) {
      cacheOfferList(findOfferList(parsed));
      return;
    }
    const m = text.match(/"offerList"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (m?.[1]) {
      try {
        cacheOfferList(JSON.parse(m[1]));
      } catch {
        /* partial json */
      }
    }
  }

  function requestUrl(arg: any): string {
    if (!arg) return "";
    if (typeof arg === "string") return arg;
    try {
      if (typeof Request !== "undefined" && arg instanceof Request) {
        return arg.url || "";
      }
    } catch {
      /* noop */
    }
    return arg?.url || "";
  }

  // fetch hook
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args: any[]) {
      const url = requestUrl(args[0]);
      return origFetch.apply(this, args).then((resp: any) => {
        return resp
          .clone()
          .text()
          .then((t: string) => {
            sniffResponse(url, t);
          })
          .catch(() => {})
          .then(() => resp);
      });
    };
  }

  // XHR hook
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async = true,
    user?: string | null,
    password?: string | null,
  ) {
    (this as any).__v2_url = String(url || "");
    return (origOpen as any).call(this, method, url, async, user, password);
  };
  XMLHttpRequest.prototype.send = function (...args: any[]) {
    this.addEventListener("load", function () {
      sniffResponse((this as any).__v2_url ?? "", (this as any).responseText ?? "");
    });
    return origSend.apply(this, args as []);
  };

  // --- page-data access ----------------------------------------------------

  function pageData(): { data: any; source: string | null } {
    if (window.__INIT_DATA) return { data: window.__INIT_DATA, source: "__INIT_DATA" };
    if (window.context && typeof window.context === "object") {
      return { data: window.context, source: "context" };
    }
    for (const key of ["__STORE__", "g_config", "__pageData"]) {
      if (window[key]) return { data: window[key], source: key };
    }
    // fallback: scan inline scripts for __INIT_DATA-shaped blobs
    for (const s of document.querySelectorAll("script:not([src])")) {
      const hit = findInitData(s.textContent ?? "");
      if (hit) return { data: hit, source: "script" };
    }
    return { data: null, source: null };
  }

  function respond(requestId: string, payload: Record<string, unknown>) {
    document.dispatchEvent(
      new CustomEvent("v2:1688:res", { detail: { requestId, ...payload } }),
    );
  }

  function isListPage(): boolean {
    return (
      /\/page\/offerlist/i.test(location.pathname) ||
      /(^|\.)s\.1688\.com$/i.test(location.hostname)
    );
  }

  /** Fetch an offer detail page in-session and parse its __INIT_DATA. */
  async function collectByOfferId(offerId: string) {
    if (isListPage()) {
      throw new Error("列表页禁止页内拉详情（风控保护）");
    }
    const id = String(offerId || "").trim();
    if (!id) throw new Error("缺少 offerId");
    const url = `https://detail.1688.com/offer/${id}.html`;
    const resp = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!resp.ok) throw new Error(`拉取详情失败 HTTP ${resp.status}`);
    const html = await resp.text();
    const data = findInitData(html);
    if (!data) throw new Error("未解析到 __INIT_DATA");
    return normalizeOffer(data, id, url);
  }

  document.addEventListener("v2:1688:req", (ev: any) => {
    const { requestId, action, offerId } = ev?.detail ?? {};
    if (!requestId) return;
    (async () => {
      if (action === "getProductData") {
        const { data, source } = pageData();
        if (!data) throw new Error("当前页无 __INIT_DATA/context");
        return { offer: normalizeOffer(data, offerId, location.href), source };
      }
      if (action === "collectProductByOfferId") {
        return { offer: await collectByOfferId(offerId) };
      }
      if (action === "getShopOfferList") {
        const cached = window[CACHE_KEY];
        if (Array.isArray(cached?.offerList) && cached.offerList.length) {
          return { offerList: cached.offerList };
        }
        const { data } = pageData();
        const list = data ? findOfferList(data) : null;
        if (list?.length) {
          cacheOfferList(list);
          return { offerList: list };
        }
        throw new Error("未缓存到店铺商品列表（先翻一下列表页让它加载）");
      }
      throw new Error(`unknown action ${action}`);
    })().then(
      (result) => respond(requestId, { ok: true, result }),
      (err) => respond(requestId, { ok: false, error: String(err?.message ?? err) }),
    );
  });
}
