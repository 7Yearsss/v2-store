/**
 * 1688 list pages (search results, shop offer lists): a "+ 采集" button on
 * every product card, plus batch-collect in the side panel. Details are
 * fetched by the background worker in the user's 1688 session — the page
 * itself never requests detail pages (risk control).
 */

import { sendToBackground } from "./lib/messages";
import type { PendingChanged } from "./lib/messages";
import { el, mountPanel, type Panel, sleep } from "./ui/panel";

type CardState = "idle" | "busy" | "staged" | "done" | "err";

interface Card {
  offerId: string;
  root: HTMLElement;
  btn: HTMLButtonElement;
  state: CardState;
}

const BTN_CSS =
  "position:absolute;white-space:nowrap;padding:4px 10px;border:none;border-radius:14px;" +
  "font:12px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;" +
  "box-shadow:0 2px 8px rgba(0,0,0,.2);";
const STYLE: Record<CardState, string> = {
  idle: "background:#f97316;color:#fff;",
  busy: "background:#fed7aa;color:#9a3412;cursor:wait;",
  staged: "background:#2563eb;color:#fff;",
  done: "background:#16a34a;color:#fff;",
  err: "background:#dc2626;color:#fff;",
};
const LABEL: Record<CardState, string> = {
  idle: "+ 采集",
  busy: "加入中…",
  staged: "✓ 待确认",
  done: "✓ 已采集",
  err: "重试",
};

const cards = new Map<string, Card>();
let panel: Panel;
let batchRunning = false;
let batchStop = false;

function offerIdOf(href: string): string | null {
  return href.match(/\/offer\/(\d{6,})\.html/)?.[1] ?? href.match(/[?&]offerId=(\d{6,})/)?.[1] ?? null;
}

/** The product card for an offer link: the search card anchor, or the
 *  nearest ancestor that holds a product image. */
function cardRootOf(a: HTMLAnchorElement): HTMLElement | null {
  const search = a.closest<HTMLElement>("a.search-offer-item, .search-offer-wrapper");
  if (search) return search;
  let node: HTMLElement | null = a;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    const img = node.querySelector("img");
    if (img && img.getBoundingClientRect().width >= 100) return node;
  }
  return null;
}

function setState(card: Card, state: CardState, note?: string) {
  card.state = state;
  card.btn.textContent = LABEL[state];
  card.btn.style.cssText = BTN_CSS + STYLE[state];
  card.btn.title = note ?? "";
  card.btn.disabled = state === "busy";
  queueLayout(); // cssText reset dropped the position
}

function cardInfo(card: Card): { title: string; image?: string } {
  const img = card.root.querySelector("img");
  const title =
    card.root.querySelector<HTMLElement>(".title-text, [class*=title]")?.innerText?.trim() ||
    img?.alt ||
    card.offerId;
  return { title: title.slice(0, 60), image: img?.src };
}

/** 点卡片按钮：只把卡片信息加进待确认队列，真正入库由面板「提交」触发。 */
async function collect(card: Card): Promise<boolean> {
  if (card.state === "busy") return false;
  if (card.state === "staged") {
    // 已在待确认里 → 再点一次移出
    setState(card, "busy");
    try {
      await sendToBackground({ type: "UNSTAGE", offerId: card.offerId });
      setState(card, "idle");
    } catch {
      setState(card, "staged");
    }
    return false;
  }
  setState(card, "busy");
  try {
    const info = cardInfo(card);
    await sendToBackground({
      type: "STAGE_COLLECT",
      item: { offerId: card.offerId, title: info.title, image: info.image, price: cardPrice(card) },
    });
    setState(card, "staged");
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setState(card, "err", msg);
    if (msg.includes("授权")) await panel.refreshStatus();
    throw e;
  } finally {
    renderStats();
  }
}

/** 卡片价格文本：1688 卡片价格 class 不稳定，捞第一个含 ¥ 的节点。 */
function cardPrice(card: Card): string | undefined {
  const node =
    card.root.querySelector<HTMLElement>("[class*=price], [class*=Price]") ??
    [...card.root.querySelectorAll<HTMLElement>("span, div")].find((n) =>
      /^[¥￥]\s*\d/.test(n.innerText?.trim() ?? "") && n.childElementCount === 0,
    );
  const t = node?.innerText?.trim().split("\n")[0];
  return t ? t.slice(0, 24) : undefined;
}

/**
 * Buttons live in our own Shadow-DOM layer positioned over the cards, NOT
 * inside 1688's markup: cards are `<a target=_blank>` with page-level click
 * handlers that fire before (and instead of) anything nested inside them.
 */
const layerHost = el("div", {
  id: "v2store-card-layer",
  style: "position:absolute;left:0;top:0;width:0;height:0;z-index:2147482000;",
});
const layer = layerHost.attachShadow({ mode: "open" });
document.body.append(layerHost);
// keep page listeners from seeing our clicks at all
for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "auxclick"]) {
  layerHost.addEventListener(type, (ev) => ev.stopPropagation());
}

/** Is the card's corner covered by page chrome (e.g. the sticky search bar)? */
function occluded(card: Card, x: number, y: number): boolean {
  if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) return false;
  const hit = document.elementsFromPoint(x, y).find((n) => n !== layerHost);
  return !!hit && !card.root.contains(hit);
}

/** Pin every button to its card's top-right corner (document coordinates). */
function layout() {
  for (const card of cards.values()) {
    const r = card.root.getBoundingClientRect();
    const hidden =
      !card.root.isConnected || r.width < 80 || r.height < 80 || occluded(card, r.right - 30, r.top + 20);
    card.btn.style.display = hidden ? "none" : "";
    if (hidden) continue;
    card.btn.style.top = `${r.top + window.scrollY + 8}px`;
    card.btn.style.left = `${r.right + window.scrollX - card.btn.offsetWidth - 8}px`;
  }
}

let layoutQueued = false;
function queueLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layout();
  });
}

function attach(a: HTMLAnchorElement) {
  const offerId = offerIdOf(a.href);
  if (!offerId || cards.has(offerId)) return;
  const root = cardRootOf(a);
  if (!root || root.dataset.v2Card) return;
  root.dataset.v2Card = offerId;
  const btn = el("button", { type: "button" });
  const card: Card = { offerId, root, btn, state: "idle" };
  btn.addEventListener("click", () => {
    collect(card).catch(() => {});
  });
  setState(card, "idle");
  layer.append(btn);
  cards.set(offerId, card);
}

let pendingCheck: string[] = [];
let checkTimer: number | undefined;

/** Batch-mark cards already in the collect box. */
function queueCheck(ids: string[]) {
  pendingCheck.push(...ids);
  clearTimeout(checkTimer);
  checkTimer = window.setTimeout(async () => {
    const batch = pendingCheck.splice(0, 500);
    if (!batch.length || !panel.status.authorized) return;
    try {
      const res = await sendToBackground<{ collected?: string[] }>({
        type: "CHECK_COLLECTED",
        items: batch.map((itemId) => ({ itemId })),
      });
      for (const id of res.collected ?? []) {
        const c = cards.get(id);
        if (c && c.state === "idle") setState(c, "done");
      }
    } catch {
      /* offline — leave cards idle */
    }
    renderStats();
  }, 400);
}

function scan() {
  const before = new Set(cards.keys());
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(attach);
  const added = [...cards.keys()].filter((id) => !before.has(id));
  if (added.length) {
    queueCheck(added);
    renderStats();
  }
  queueLayout();
}

// --- panel -------------------------------------------------------------------

const stats = el("div", { class: "stat" });
const batchBtn = el("button", { class: "btn primary" });
const stopBtn = el("button", { class: "btn", style: "display:none" }, "停止");

function renderStats() {
  const all = [...cards.values()];
  const staged = all.filter((c) => c.state === "staged").length;
  const todo = all.filter((c) => c.state === "idle" || c.state === "err").length;
  stats.replaceChildren(
    "本页识别 ",
    el("b", {}, String(all.length)),
    " 个商品 · 待确认 ",
    el("b", {}, String(staged)),
  );
  if (!batchRunning) {
    batchBtn.textContent = todo ? `全部加入待确认（${todo}）` : "本页已全部加入";
    batchBtn.disabled = !todo || !panel.status.authorized;
  }
}

async function runBatch() {
  const queue = [...cards.values()].filter((c) => c.state === "idle" || c.state === "err");
  if (!queue.length) return;
  batchRunning = true;
  batchStop = false;
  batchBtn.disabled = true;
  stopBtn.textContent = "停止";
  stopBtn.style.display = "";
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < queue.length && !batchStop; i++) {
    batchBtn.textContent = `加入中 ${i + 1}/${queue.length}…`;
    panel.progress(i, queue.length);
    try {
      await collect(queue[i]!);
      ok++;
    } catch {
      fail++;
    }
    await sleep(120); // stage 是本地操作，不用走 1688 限流节奏
  }
  panel.progress(0, null);
  batchRunning = false;
  stopBtn.style.display = "none";
  panel.toast(`已加入待确认 ${ok} 个${fail ? `，失败 ${fail} 个` : ""}，在下面列表勾选后提交`, fail === 0);
  renderStats();
}

(async () => {
  panel = await mountPanel();
  batchBtn.onclick = () => runBatch();
  stopBtn.onclick = () => {
    batchStop = true;
    stopBtn.textContent = "正在停止…";
  };
  panel.setActions(
    stats,
    batchBtn,
    stopBtn,
    el("div", { class: "stat", style: "font-size:12px" }, "点卡片右上「+ 采集」或上方批量按钮加入待确认，在下方列表勾选后提交入库。"),
  );
  renderStats();
  scan();

  // 页面打开时同步一次待确认队列（跨 tab 的 stage 也生效；广播只管之后的变化）
  void sendToBackground<{ items: { offerId: string }[] }>({ type: "GET_PENDING" })
    .then((res) => {
      const staged = new Set(res.items.map((i) => i.offerId));
      for (const card of cards.values()) {
        if (card.state !== "done" && staged.has(card.offerId)) setState(card, "staged");
      }
      renderStats();
    })
    .catch(() => {});

  // 待确认变化/提交完成时同步卡片状态
  chrome.runtime.onMessage.addListener((msg: PendingChanged) => {
    if (msg?.type !== "V2_PENDING_CHANGED") return;
    const staged = new Set(msg.stagedIds);
    const okIds = new Set(msg.okIds);
    for (const card of cards.values()) {
      if (okIds.has(card.offerId)) setState(card, "done");
      else if (staged.has(card.offerId) && card.state !== "done") setState(card, "staged");
      else if (card.state === "staged" && !staged.has(card.offerId)) setState(card, "idle");
    }
    renderStats();
  });
  // cards move as images load and the layout reflows
  window.addEventListener("resize", queueLayout);
  window.addEventListener("scroll", queueLayout, { passive: true });
  window.setInterval(queueLayout, 1000);
  // search results and shop lists lazy-load while scrolling
  let t: number | undefined;
  new MutationObserver(() => {
    clearTimeout(t);
    t = window.setTimeout(scan, 300);
  }).observe(document.body, { childList: true, subtree: true });
})();
