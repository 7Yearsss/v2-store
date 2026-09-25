/**
 * Floating side panel shown on 1688 pages (Shadow DOM, so page CSS can't
 * leak in or out). Detail and list pages fill the action area; the panel
 * owns auth status, a progress bar and the session's collect log.
 */

import { sendToBackground } from "../lib/messages";

export interface ExtStatus {
  authorized: boolean;
  appUrl: string | null;
}

const CSS = `
:host { all: initial; }
.root { position: fixed; top: 120px; right: 72px; z-index: 2147483000; width: 272px;
  font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  color: #1f2937; background: #fff; border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); overflow: hidden; }
.root.min { width: auto; border-radius: 22px; }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  background: #f97316; color: #fff; cursor: default; user-select: none; }
.logo { font-weight: 700; letter-spacing: .3px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #fde68a; flex: none; }
.dot.ok { background: #86efac; }
.spacer { flex: 1; }
.icon { border: none; background: transparent; color: #fff; cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; }
.root.min .body { display: none; }
.root.min .title-extra { display: none; }
.body { padding: 12px; display: flex; flex-direction: column; gap: 10px; max-height: 70vh; overflow: auto; }
.notice { padding: 8px 10px; border-radius: 8px; background: #fff7ed; color: #9a3412; }
.notice a { color: #c2410c; }
.stat { color: #6b7280; }
.stat b { color: #111827; }
.btn { display: block; width: 100%; box-sizing: border-box; padding: 8px 12px; border-radius: 8px;
  border: 1px solid #e5e7eb; background: #fff; color: #111827; font: inherit; cursor: pointer; text-align: center; }
.btn:hover:not(:disabled) { border-color: #f97316; color: #ea580c; }
.btn.primary { background: #f97316; border-color: #f97316; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #ea580c; color: #fff; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.row { display: flex; gap: 8px; }
.row .btn { flex: 1; }
.progress { height: 6px; background: #f3f4f6; border-radius: 3px; overflow: hidden; }
.progress > i { display: block; height: 100%; width: 0; background: #f97316; transition: width .2s; }
.log { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #f3f4f6; padding-top: 8px; }
.log-title { color: #9ca3af; font-size: 12px; }
.item { display: flex; gap: 8px; align-items: center; }
.item img { width: 32px; height: 32px; border-radius: 4px; object-fit: cover; background: #f3f4f6; flex: none; }
.item .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag { font-size: 11px; padding: 0 6px; border-radius: 8px; flex: none; }
.tag.ok { background: #dcfce7; color: #15803d; }
.tag.dup { background: #e0f2fe; color: #0369a1; }
.tag.err { background: #fee2e2; color: #b91c1c; }
.link { color: #ea580c; text-decoration: none; text-align: center; }
.toast { position: fixed; top: 72px; right: 16px; z-index: 2147483001; max-width: 320px; padding: 10px 14px;
  border-radius: 8px; color: #fff; font: 13px/1.5 system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
`;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) (node as any)[k.toLowerCase()] = v;
    else if (k in node) (node as any)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

export interface Panel {
  status: ExtStatus;
  /** replace the page-specific action area */
  setActions(...nodes: Node[]): void;
  progress(done: number, total: number | null): void;
  log(entry: { title: string; image?: string; state: "ok" | "dup" | "err"; note?: string }): void;
  toast(msg: string, ok?: boolean): void;
  refreshStatus(): Promise<ExtStatus>;
}

const MIN_KEY = "v2store:panel:min";

export async function mountPanel(): Promise<Panel> {
  const host = el("div", { id: "v2store-panel" });
  const shadow = host.attachShadow({ mode: "open" });
  shadow.append(el("style", {}, CSS));

  const dot = el("span", { class: "dot" });
  const root = el("div", { class: "root" });
  const toggle = el("button", { class: "icon", title: "最小化" }, "–");
  const head = el(
    "div",
    { class: "head" },
    dot,
    el("span", { class: "logo" }, "V2Store"),
    el("span", { class: "title-extra" }, " 采集"),
    el("span", { class: "spacer" }),
    toggle,
  );
  const authArea = el("div");
  const actions = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
  const bar = el("i");
  const progressWrap = el("div", { class: "progress", style: "display:none" }, bar);
  const logList = el("div", { class: "log", style: "display:none" }, el("div", { class: "log-title" }, "本次采集"));
  const appLink = el("a", { class: "link", target: "_blank", rel: "noreferrer" }, "打开 V2Store 工作台 →");
  const body = el("div", { class: "body" }, authArea, actions, progressWrap, logList, appLink);
  root.append(head, body);
  shadow.append(root);
  document.documentElement.append(host);

  const setMin = (min: boolean) => {
    root.classList.toggle("min", min);
    toggle.textContent = min ? "+" : "–";
    toggle.title = min ? "展开" : "最小化";
    try {
      localStorage.setItem(MIN_KEY, min ? "1" : "");
    } catch {
      /* storage blocked */
    }
  };
  toggle.onclick = () => setMin(!root.classList.contains("min"));
  try {
    setMin(localStorage.getItem(MIN_KEY) === "1");
  } catch {
    /* storage blocked */
  }

  const panel: Panel = {
    status: { authorized: false, appUrl: null },
    setActions(...nodes) {
      actions.replaceChildren(...nodes);
    },
    progress(done, total) {
      if (total == null) {
        progressWrap.style.display = "none";
        return;
      }
      progressWrap.style.display = "";
      bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    },
    log({ title, image, state, note }) {
      logList.style.display = "";
      const label = { ok: "已采集", dup: "已更新", err: "失败" }[state];
      const row = el(
        "div",
        { class: "item", title: note ?? title },
        el("img", { src: image ?? "", alt: "" }),
        el("span", { class: "t" }, title),
        el("span", { class: `tag ${state}` }, label),
      );
      logList.insertBefore(row, logList.children[1] ?? null);
      while (logList.children.length > 9) logList.lastElementChild?.remove();
    },
    toast(msg, ok = true) {
      const t = el("div", { class: "toast", style: `background:${ok ? "#16a34a" : "#dc2626"}` }, msg);
      shadow.append(t);
      setTimeout(() => t.remove(), 4000);
    },
    async refreshStatus() {
      try {
        panel.status = await sendToBackground<ExtStatus>({ type: "GET_STATUS" });
      } catch {
        panel.status = { authorized: false, appUrl: null };
      }
      const { authorized, appUrl } = panel.status;
      dot.classList.toggle("ok", authorized);
      dot.title = authorized ? "已授权" : "未授权";
      appLink.href = appUrl ?? "#";
      appLink.style.display = appUrl ? "" : "none";
      authArea.replaceChildren(
        authorized
          ? ""
          : el(
              "div",
              { class: "notice" },
              "插件未授权：打开工作台，点右上角「授权插件」后刷新本页。",
              appUrl ? el("a", { href: appUrl, target: "_blank" }, " 去授权") : null,
            ),
      );
      return panel.status;
    },
  };
  await panel.refreshStatus();
  return panel;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
