import { findInitData, normalizeOffer } from "@caiji/shared";
import { describe, expect, it } from "vitest";
import { offerHtml } from "./helpers.js";

/** Shape of detail.1688.com pages as of 2026-09 (window.context IIFE). */
function contextPageHtml() {
  const payload = {
    result: {
      data: { gallery: { fields: { subject: "ignored" } } },
      global: {
        globalData: {
          model: {
            offerDetail: {
              offerId: 930374004918,
              subject: "新款不锈钢保温杯 真空保温杯",
              leafCategoryName: "保温杯",
              imageList: [
                { fullPathImageURI: "https://cbu01.alicdn.com/img/ibank/a.jpg" },
                { fullPathImageURI: "https://cbu01.alicdn.com/img/ibank/b.jpg" },
              ],
              skuProps: [
                { fid: 3216, prop: "颜色", value: [{ name: "白色" }, { name: "绿色" }] },
                { fid: 1, prop: "容量", value: [{ name: "600ml" }] },
              ],
              featureAttributes: [
                { name: "内胆材质", value: "316不锈钢", values: ["316不锈钢"] },
                { name: "颜色", value: "白色", values: ["白色", "绿色"] },
              ],
            },
            tradeModel: {
              minPrice: "16.50",
              maxPrice: "18.00",
              priceDisplay: "16.50",
              skuMap: [
                { specAttrs: "白色&gt;600ml", price: "16.50", discountPrice: "16.50", canBookCount: 5140, specId: "s1", skuId: 1 },
                { specAttrs: "绿色&gt;600ml", price: "18.00", discountPrice: "", canBookCount: 10, specId: "s2", skuId: 2 },
              ],
            },
            sellerModel: { companyName: "义乌某工厂", loginId: "seller1" },
          },
        },
      },
    },
    version: "0.26.16",
  };
  return (
    `<html><head><script>\r\nwindow.contextPath = "/default";\r\n` +
    `window.context=(function(b,d){var c=d.module||{};return d})(window.contextPath,` +
    // real pages are JS object literals, e.g. a bare numeric key: {98:"…"}
    `${JSON.stringify(payload).slice(0, -1)},"rightQAMap":{98:"[\\"(1)a,b:c\\"]", x_y :1}});\r\n` +
    `</script></head><body></body></html>`
  );
}

describe("1688 offer parsing", () => {
  it("parses the current window.context page format", () => {
    const data = findInitData(contextPageHtml());
    expect(data).not.toBeNull();
    const offer = normalizeOffer(data, undefined, "https://detail.1688.com/offer/930374004918.html");
    expect(offer).toMatchObject({
      offerId: "930374004918",
      title: "新款不锈钢保温杯 真空保温杯",
      priceText: "16.50-18.00",
      sellerName: "义乌某工厂",
      categoryPath: ["保温杯"],
      images: [
        "https://cbu01.alicdn.com/img/ibank/a.jpg",
        "https://cbu01.alicdn.com/img/ibank/b.jpg",
      ],
      attributes: { 内胆材质: "316不锈钢", 颜色: "白色,绿色" },
    });
    expect(offer.skus).toEqual([
      { skuId: "s1", spec: "颜色:白色 / 容量:600ml", priceCny: 16.5, stock: 5140 },
      // empty discountPrice falls back to price
      { skuId: "s2", spec: "颜色:绿色 / 容量:600ml", priceCny: 18, stock: 10 },
    ]);
  });

  it("still parses the legacy __INIT_DATA format", () => {
    const offer = normalizeOffer(findInitData(offerHtml("1", "旧版")));
    expect(offer.title).toBe("旧版");
    expect(offer.skus).toHaveLength(2);
  });
});
