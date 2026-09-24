import type { CollectedOffer } from "@caiji/shared";
import { collectorRequest } from "./lib/bridge";
import { proxyFetchJson } from "./lib/proxyFetch";

const API = "http://localhost:3000";

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

function makeBtn(text: string, top: number): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.style.cssText =
    `position:fixed;top:${top}px;right:16px;z-index:999999;padding:10px 16px;border:none;` +
    "border-radius:8px;background:#f97316;color:#fff;font-size:14px;cursor:pointer;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:system-ui";
  document.body.appendChild(b);
  return b;
}

async function pushOffer(offer: CollectedOffer) {
  const res = await proxyFetchJson<{ ok: boolean; duplicated?: boolean }>(
    `${API}/api/collect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: offer,
    },
  );
  return res;
}

const collectBtn = makeBtn("采集此商品", 96);
collectBtn.onclick = async () => {
  collectBtn.disabled = true;
  try {
    const { offer } = await collectorRequest<{ offer: CollectedOffer }>(
      "getProductData",
    );
    const res = await pushOffer(offer);
    toast(res.duplicated ? "已更新（重复采集）" : "采集成功");
  } catch (e) {
    toast(`失败: ${e instanceof Error ? e.message : e}`, false);
  } finally {
    collectBtn.disabled = false;
  }
};

const shopBtn = makeBtn("采集整店", 140);
shopBtn.onclick = async () => {
  shopBtn.disabled = true;
  shopBtn.textContent = "读取店铺列表…";
  try {
    const { offerList } = await collectorRequest<{ offerList: any[] }>(
      "getShopOfferList",
    );
    const ids = [
      ...new Set(
        offerList
          .map((o) => String(o?.offerId ?? o?.id ?? ""))
          .filter(Boolean),
      ),
    ].slice(0, 50); // 限速且限量，防风控
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < ids.length; i++) {
      shopBtn.textContent = `整店采集 ${i + 1}/${ids.length}`;
      try {
        const { offer } = await collectorRequest<{ offer: CollectedOffer }>(
          "collectProductByOfferId",
          { offerId: ids[i] },
        );
        await pushOffer(offer);
        ok++;
      } catch {
        fail++;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    toast(`整店采集完成：成功 ${ok} 失败 ${fail}`, fail === 0);
  } catch (e) {
    toast(`失败: ${e instanceof Error ? e.message : e}`, false);
  } finally {
    shopBtn.disabled = false;
    shopBtn.textContent = "采集整店";
  }
};
