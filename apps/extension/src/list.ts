/**
 * 1688 list pages (search results, shop offer lists): a "+ 采集" button on
 * every product card, plus batch-collect in the side panel. Details are
 * fetched by the background worker in the user's 1688 session — the page
 * itself never requests detail pages (risk control).
 */

import { sendToBackground, type SubmitResult } from "./lib/messages";
import { el, mountPanel, type Panel, sleep } from "./ui/panel";

type CardState = "idle" | "busy" | "done" | "err";

interface Card {
  offerId: string;
  root: HTMLElement;
  btn: HTMLButtonElement;
  state: CardState;
}

const BTN_CSS =
  "position:absolute;top:8px;right:8px;z-index:20;padding:4px 10px;border:none;border-radius:14px;" +
  "font:12px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;" +
  "box-shadow:0 2px 8px rgba(0,0,0,.2);";
const STYLE: Record<CardState, string> = {
  idle: "background:#f97316;color:#fff;",
  busy: "background:#fed7aa;color:#9a3412;cursor:wait;",
  done: "background:#16a34a;color:#fff;",
  err: "background:#dc2626;color:#fff;",
};
const LABEL: Record<CardState, string> = {
  idle: "+ 采集",
  busy: "采集中…",
  done: "✓ 已采集",
  err: "重试采集",
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
}

function cardInfo(card: Card): { title: string; image?: string } {
  const img = card.root.querySelector("img");
  const title =
    card.root.querySelector<HTMLElement>(".title-text, [class*=title]")?.innerText?.trim() ||
    img?.alt ||
    card.offerId;
  return { title: title.slice(0, 60), image: img?.src };
}

async function collect(card: Card): Promise<boolean> {
  if (card.state === "busy") return false;
  setState(card, "busy");
  try {
    const res = await sendToBackground<SubmitResult>({
      type: "COLLECT_BY_OFFER_ID",
      offerId: card.offerId,
    });
    setState(card, "done");
    panel.log({
      title: res.item.title,
      image: res.item.images?.[0] ?? cardInfo(card).image,
      state: res.duplicated ? "dup" : "ok",
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setState(card, "err", msg);
    panel.log({ ...cardInfo(card), state: "err", note: msg });
    if (msg.includes("授权")) await panel.refreshStatus();
    throw e;
  } finally {
    renderStats();
  }
}

function attach(a: HTMLAnchorElement) {
  const offerId = offerIdOf(a.href);
  if (!offerId || cards.has(offerId)) return;
  const root = cardRootOf(a);
  if (!root || root.dataset.v2Card) return;
  root.dataset.v2Card = offerId;
  if (getComputedStyle(root).position === "static") root.style.position = "relative";
  const btn = el("button", { type: "button" });
  const card: Card = { offerId, root, btn, state: "idle" };
  btn.addEventListener("click", (ev) => {
    // cards are often <a> links — don't navigate
    ev.preventDefault();
    ev.stopPropagation();
    collect(card).catch(() => {});
  });
  setState(card, "idle");
  root.append(btn);
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
}

// --- panel -------------------------------------------------------------------

const stats = el("div", { class: "stat" });
const batchBtn = el("button", { class: "btn primary" });
const stopBtn = el("button", { class: "btn", style: "display:none" }, "停止");

function renderStats() {
  const all = [...cards.values()];
  const done = all.filter((c) => c.state === "done").length;
  const todo = all.filter((c) => c.state === "idle" || c.state === "err").length;
  stats.replaceChildren(
    "本页识别 ",
    el("b", {}, String(all.length)),
    " 个商品 · 已采集 ",
    el("b", {}, String(done)),
  );
  if (!batchRunning) {
    batchBtn.textContent = todo ? `采集本页未采集的 ${todo} 个` : "本页已全部采集";
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
    batchBtn.textContent = `采集中 ${i + 1}/${queue.length}…`;
    panel.progress(i, queue.length);
    try {
      await collect(queue[i]!);
      ok++;
    } catch (e) {
      fail++;
      const msg = e instanceof Error ? e.message : "";
      // every remaining item would fail the same way
      if (/授权|安全验证|登录/.test(msg)) {
        panel.toast(msg, false);
        break;
      }
    }
    await sleep(800 + Math.random() * 600); // pace requests; 1688 rate-limits bursts
  }
  panel.progress(0, null);
  batchRunning = false;
  stopBtn.style.display = "none";
  panel.toast(`${batchStop ? "已停止，" : ""}成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ""}`, fail === 0);
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
    el("div", { class: "stat", style: "font-size:12px" }, "也可以点每个商品卡片右上角的「+ 采集」单独采集。"),
  );
  scan();
  // search results and shop lists lazy-load while scrolling
  let t: number | undefined;
  new MutationObserver(() => {
    clearTimeout(t);
    t = window.setTimeout(scan, 300);
  }).observe(document.body, { childList: true, subtree: true });
})();
