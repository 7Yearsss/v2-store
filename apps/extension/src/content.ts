import type { CollectedOffer, OfferSku } from "@caiji/shared";

// 1688 detail pages embed offer data as JSON in inline scripts
// (iDetailData / __INIT_DATA / offer_dto shapes vary; scan tolerantly).
function deepFind(obj: unknown, keys: string[], depth = 0): any {
  if (!obj || depth > 8 || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in rec && rec[k] != null && typeof rec[k] === "object") return rec[k];
  }
  for (const v of Object.values(rec)) {
    const hit = deepFind(v, keys, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function collectEmbeddedJson(): any[] {
  const blobs: any[] = [];
  for (const s of document.querySelectorAll("script")) {
    const t = s.textContent ?? "";
    if (!t || t.length < 200) continue;
    if (!/offerId|skuModel|iDetailData|__INIT_DATA/.test(t)) continue;
    // try to grab the largest {...} JSON-looking block
    const m = t.match(/=\s*(\{[\s\S]*\})\s*;?\s*(?:<\/script>|$)/) ?? t.match(/(\{[\s\S]*\})/);
    if (!m) continue;
    try {
      blobs.push(JSON.parse(m[1]));
    } catch {
      /* not clean JSON — skip */
    }
  }
  return blobs;
}

function text(sel: string): string | undefined {
  return document.querySelector(sel)?.textContent?.trim() || undefined;
}

function extractSkus(blobs: any[]): OfferSku[] {
  const skus: OfferSku[] = [];
  for (const b of blobs) {
    const skuModel = deepFind(b, ["skuModel", "skuInfo"]);
    const list = (skuModel?.skuInfoMap && Object.values(skuModel.skuInfoMap)) ||
      skuModel?.skuProps?.[0]?.value || skuModel?.skuInfoList;
    if (Array.isArray(list)) {
      for (const it of list as any[]) {
        skus.push({
          skuId: it?.skuId ? String(it.skuId) : undefined,
          spec: it?.specId ?? it?.name ?? it?.specName ?? "",
          priceCny: Number(it?.price ?? it?.discountPrice ?? NaN) || undefined,
          stock: Number(it?.canBookCount ?? it?.amountOnSale ?? NaN) || undefined,
        });
      }
      if (skus.length) return skus;
    }
  }
  return skus;
}

function extractImages(blobs: any[]): string[] {
  for (const b of blobs) {
    const img = deepFind(b, ["image", "images", "offerImg"]);
    const list = img?.offerImageList ?? img?.images ?? img?.list ?? img;
    if (Array.isArray(list)) {
      const urls = list
        .map((i: any) => (typeof i === "string" ? i : i?.url ?? i?.imgUrl ?? i?.originalImageURI))
        .filter(Boolean);
      if (urls.length) return urls.map((u: string) => (u.startsWith("//") ? `https:${u}` : u));
    }
  }
  const og = document.querySelectorAll('meta[property="og:image"], img[src*="alicdn"]');
  return [...og]
    .map((el) => el.getAttribute("content") ?? el.getAttribute("src") ?? "")
    .filter(Boolean);
}

function extractAttributes(blobs: any[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const b of blobs) {
    const list = deepFind(b, ["productFeatureList", "attributes", "featureList"]);
    if (Array.isArray(list)) {
      for (const f of list as any[]) {
        const k = f?.name ?? f?.attributeName;
        const v = f?.value ?? f?.attributeValue ?? f?.valueStr;
        if (k && v) attrs[String(k)] = String(v);
      }
      if (Object.keys(attrs).length) break;
    }
  }
  return attrs;
}

function extract(): CollectedOffer {
  const blobs = collectEmbeddedJson();
  const offerId = location.pathname.match(/offer\/(\d+)/)?.[1];
  const title =
    text("h1") ??
    document.querySelector('meta[property="og:title"]')?.getAttribute("content") ??
    document.title;
  const priceText =
    document.querySelector("[class*=price], .price-text, .discount-price")
      ?.textContent?.trim() ?? undefined;
  return {
    sourcePlatform: "1688",
    sourceUrl: location.href.split("?")[0],
    offerId,
    title,
    priceText,
    skus: extractSkus(blobs),
    images: extractImages(blobs),
    attributes: extractAttributes(blobs),
    sellerName: text("[class*=company-name], [class*=shop-name]"),
    collectedAt: new Date().toISOString(),
  };
}

function toast(msg: string, ok = true) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:999999;padding:10px 14px;border-radius:8px;font-size:13px;color:#fff;background:" +
    (ok ? "#16a34a" : "#dc2626") + ";box-shadow:0 4px 14px rgba(0,0,0,.25)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

const btn = document.createElement("button");
btn.textContent = "采集到 Caiji";
btn.style.cssText =
  "position:fixed;bottom:96px;right:16px;z-index:999999;padding:10px 16px;border:none;border-radius:8px;background:#f97316;color:#fff;font-size:14px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)";
btn.onclick = async () => {
  btn.disabled = true;
  try {
    const payload = extract();
    const res = await chrome.runtime.sendMessage({ type: "COLLECT", payload });
    if (res?.ok) {
      toast(res.data?.duplicated ? "已更新（重复采集）" : "采集成功");
    } else {
      toast(`失败: ${res?.error ?? "unknown"}`, false);
    }
  } catch (e) {
    toast(`失败: ${e}`, false);
  } finally {
    btn.disabled = false;
  }
};
document.body.appendChild(btn);
