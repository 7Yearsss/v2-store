/**
 * Offscreen document：SW 没有 DOM，列表页 HTML 卡片的 DOMParser 解析放这里。
 * 后台 fetch 到搜索/榜单页后发来 PARSE_OFFER_CARDS，这里回结构化候选。
 */

import type { DiscoveryFeedItem } from "@caiji/shared";
import { signalsFromText } from "./lib/cardSignals";

function absUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  const v = u.trim();
  if (v.startsWith("//")) return `https:${v}`;
  if (v.startsWith("http")) return v;
  return undefined;
}

function offerIdOf(href: string): string | null {
  return (
    href.match(/\/offer\/(\d{6,})\.html/)?.[1] ?? href.match(/[?&]offerId=(\d{6,})/)?.[1] ?? null
  );
}

/** 卡片容器：搜索卡 class 优先，否则向上找第一个带商品图的祖先。 */
function cardRootOf(a: Element): Element | null {
  const named = a.closest(
    "a.search-offer-item, .search-offer-wrapper, [class*=offer-item], [class*=card], li",
  );
  if (named?.querySelector("img")) return named;
  let node: Element | null = a;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    if (node.querySelector("img")) return node;
  }
  return null;
}

function priceTextOf(root: Element): string | undefined {
  const node =
    root.querySelector("[class*=price], [class*=Price]") ??
    [...root.querySelectorAll("span, div")].find(
      (n) => /^[¥￥]\s*\d/.test(n.textContent?.trim() ?? "") && n.childElementCount === 0,
    );
  const t = node?.textContent?.trim().split("\n")[0];
  return t ? t.slice(0, 24) : undefined;
}

export function parseOfferCards(html: string): DiscoveryFeedItem[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items: DiscoveryFeedItem[] = [];
  const seen = new Set<string>();
  for (const a of doc.querySelectorAll('a[href*="/offer/"], a[href*="offerId="]')) {
    const offerId = offerIdOf(a.getAttribute("href") ?? "");
    if (!offerId || seen.has(offerId)) continue;
    const root = cardRootOf(a);
    if (!root) continue;
    seen.add(offerId);
    const img = root.querySelector("img");
    const title =
      root.querySelector(".title-text, [class*=title]")?.textContent?.trim() ||
      img?.getAttribute("alt")?.trim() ||
      offerId;
    const text = (root as HTMLElement).innerText ?? root.textContent ?? "";
    items.push({
      sourceItemId: offerId,
      title: title.slice(0, 120),
      priceText: priceTextOf(root),
      thumb: absUrl(img?.getAttribute("src") ?? img?.getAttribute("data-src")),
      signals: { ...signalsFromText(text), rank: items.length + 1 },
    });
    if (items.length >= 60) break;
  }
  return items;
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { type?: string; html?: string };
  if (m?.type !== "PARSE_OFFER_CARDS") return false;
  try {
    sendResponse({ items: parseOfferCards(m.html ?? "") });
  } catch (e) {
    sendResponse({ items: [], error: String(e) });
  }
  return true;
});
