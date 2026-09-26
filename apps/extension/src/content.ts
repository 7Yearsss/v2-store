/**
 * 1688 detail pages: collect this offer (page data → server) or the whole
 * shop (offer list sniffed on this page → background fetch per offer).
 */

import type { CollectHarvest } from "@caiji/shared";
import { collectorRequest } from "./lib/bridge";
import { sendToBackground, type SubmitResult } from "./lib/messages";
import { el, mountPanel, sleep } from "./ui/panel";

const offerId = location.href.match(/offer\/(\d+)/)?.[1];

(async () => {
  const panel = await mountPanel();

  // right-click menu results land here
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "V2_TOAST") panel.toast(String(msg.msg ?? ""), msg.ok !== false);
  });

  const collectBtn = el("button", { class: "btn primary" }, "采集此商品");
  const shopBtn = el("button", { class: "btn" }, "整店加入待确认（最多 50 个）");
  const hint = el("div", { class: "stat" });
  panel.setActions(hint, collectBtn, shopBtn);

  const refreshEnabled = () => {
    collectBtn.disabled = shopBtn.disabled = !panel.status.authorized;
  };
  refreshEnabled();

  if (panel.status.authorized) {
    try {
      const res = await sendToBackground<{ collected?: string[] }>({
        type: "CHECK_COLLECTED",
        items: [{ itemUrl: location.href, itemId: offerId }],
      });
      if (res.collected?.length) {
        hint.textContent = "该商品已在采集箱中，再次采集会更新数据。";
        collectBtn.textContent = "重新采集";
      }
    } catch {
      /* server offline — keep defaults */
    }
  }

  collectBtn.onclick = async () => {
    collectBtn.disabled = true;
    try {
      const { harvest } = await collectorRequest<{ harvest: CollectHarvest }>("getProductData");
      // 详情区懒加载时 DOM 里没图；用页面数据里的 descUrl 让 background 拉 HTML 兜底
      const ext = harvest.productExtInfo ?? {};
      const descUrl = typeof ext.descUrl === "string" ? ext.descUrl : undefined;
      if (descUrl) {
        try {
          const { images } = await sendToBackground<{ images: string[] }>({
            type: "FETCH_DESC_IMAGES",
            url: descUrl,
          });
          const domImgs = Array.isArray(ext.descImages) ? (ext.descImages as string[]) : [];
          const merged = [...new Set([...domImgs, ...images])];
          if (merged.length) {
            harvest.productExtInfo = { ...ext, descImages: merged };
          }
        } catch {
          /* 详情图兜底失败不阻塞采集 */
        }
      }
      // 先入待确认队列，用户在面板勾选提交后才真正入库
      const price =
        document.querySelector<HTMLElement>("[class*=price] , [class*=Price]")?.innerText?.trim().split("\n")[0] ??
        undefined;
      const image =
        (harvest.productExtInfo?.images as string[] | undefined)?.[0] ??
        document.querySelector<HTMLImageElement>("[class*=img] img, [class*=Img] img")?.src;
      await sendToBackground({
        type: "STAGE_COLLECT",
        item: {
          offerId: offerId ?? harvest.sourceInfo.itemId ?? "",
          title: document.title.replace(/ - 阿里巴巴.*$/, "").slice(0, 60),
          image,
          price: price?.slice(0, 24),
          harvest,
        },
      });
      panel.toast("已加入待确认，在右侧面板勾选后点「提交」入库");
      collectBtn.textContent = "重新加入待确认";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      panel.toast(`采集失败：${msg}`, false);
      panel.log({ title: document.title.replace(/ - 阿里巴巴$/, "").slice(0, 40), state: "err", note: msg });
      if (msg.includes("授权")) {
        await panel.refreshStatus();
        refreshEnabled();
      }
    } finally {
      collectBtn.disabled = !panel.status.authorized;
    }
  };

  shopBtn.onclick = async () => {
    shopBtn.disabled = collectBtn.disabled = true;
    try {
      const { offerList } = await collectorRequest<{ offerList: any[] }>("getShopOfferList");
      const ids = [
        ...new Set(offerList.map((o) => String(o?.offerId ?? o?.id ?? "")).filter(Boolean)),
      ].slice(0, 50); // 限量，防风控
      let ok = 0;
      let fail = 0;
      for (let i = 0; i < ids.length; i++) {
        shopBtn.textContent = `整店采集 ${i + 1}/${ids.length}…`;
        panel.progress(i, ids.length);
        try {
          await sendToBackground({
            type: "STAGE_COLLECT",
            item: { offerId: ids[i]!, title: String(offerList[i]?.subject ?? ids[i]) },
          });
          ok++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          panel.log({ title: `offer ${ids[i]}`, state: "err", note: msg });
          fail++;
          if (/授权|安全验证|登录/.test(msg)) {
            panel.toast(msg, false);
            break;
          }
        }
        await sleep(800 + Math.random() * 600);
      }
      panel.toast(`已加入待确认 ${ok} 个${fail ? `，失败 ${fail} 个` : ""}，在面板勾选后提交`, fail === 0);
    } catch (e) {
      panel.toast(`失败：${e instanceof Error ? e.message : e}`, false);
    } finally {
      panel.progress(0, null);
      shopBtn.textContent = "整店加入待确认（最多 50 个）";
      refreshEnabled();
    }
  };
})();
