/**
 * s.1688.com search-result pages: batch-collect every offerId visible in the
 * result grid. Detail fetching goes through the background service worker
 * (COLLECT_BY_OFFER_ID) — the MAIN-world collector refuses in-page detail
 * fetches on list pages to avoid tripping risk control.
 */

function toast(msg: string, ok = true) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:999999;padding:10px 14px;border-radius:8px;font-size:13px;color:#fff;background:" +
    (ok ? "#16a34a" : "#dc2626") +
    ";box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:system-ui";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function collectOfferIds(): string[] {
  const ids = new Set<string>();
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const m = a.href.match(/(?:detail\.1688\.com)?\/offer\/(\d+)\.html/) ??
      a.href.match(/[?&]offerId=(\d+)/);
    if (m?.[1]) ids.add(m[1]);
  });
  return [...ids];
}

const btn = document.createElement("button");
btn.textContent = "采集本页结果";
btn.style.cssText =
  "position:fixed;top:96px;right:16px;z-index:999999;padding:10px 16px;border:none;" +
  "border-radius:8px;background:#f97316;color:#fff;font-size:14px;cursor:pointer;" +
  "box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:system-ui";
document.body.appendChild(btn);

btn.onclick = async () => {
  const ids = collectOfferIds().slice(0, 50);
  if (!ids.length) {
    toast("本页未识别到商品链接", false);
    return;
  }
  btn.disabled = true;
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < ids.length; i++) {
    btn.textContent = `采集本页 ${i + 1}/${ids.length}`;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "COLLECT_BY_OFFER_ID",
        offerId: ids[i],
      });
      if (res?.ok) ok++;
      else fail++;
    } catch {
      fail++;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  btn.disabled = false;
  btn.textContent = "采集本页结果";
  toast(`本页采集完成：成功 ${ok} 失败 ${fail}`, fail === 0);
};
