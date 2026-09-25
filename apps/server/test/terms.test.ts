import { afterEach, describe, expect, it } from "vitest";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, json, offerHtml, setup, type FakeFetch } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const AI_URL = "https://ai.test/v1/chat/completions";

/** AI 回复：选项 颜色→Color / 尺码→Size，值 红色→Red / M→M / L→L。 */
const AI_REPLY = {
  title: "Insulated Bottle",
  descriptionHtml: "<p>desc</p>",
  productType: "Bottle",
  tags: [],
  options: [
    { name: "Color", values: ["Red"] },
    { name: "Size", values: ["M", "L"] },
  ],
};

function fakeAll(): FakeFetch {
  const shopify = fakeShopify();
  return (url, init) => {
    if (url === AI_URL) {
      return json({ choices: [{ message: { content: JSON.stringify(AI_REPLY) } }] });
    }
    return shopify(url, init);
  };
}

function enableAi(c: Awaited<ReturnType<typeof setup>>) {
  c.deps.config.ai = { baseUrl: "https://ai.test/v1", apiKey: "k", model: "m" };
}

async function makeStore(c: Awaited<ReturnType<typeof setup>>, t: string) {
  const res = await c.api(
    "POST",
    "/api/stores/shopify",
    { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
    t,
  );
  return res.body;
}

async function collectAndClaim(
  c: Awaited<ReturnType<typeof setup>>,
  t: string,
  storeId: string,
  offerId: string,
) {
  const item = await c.api("POST", "/api/collect", harvest(offerId, "保温水杯"), t);
  const claim = await c.api(
    "POST",
    "/api/source-items/claim",
    { ids: [item.body.item.id], storeIds: [storeId] },
    t,
  );
  const list = await c.api("GET", "/api/listings", undefined, t);
  return { claim: claim.body, listing: list.body.items[0] };
}

const drain = async (c: Awaited<ReturnType<typeof setup>>) => {
  while (await runOnce(c.deps, jobHandlers)) {
    /* drain */
  }
};

describe("术语翻译映射", () => {
  it("PUT/GET/DELETE 正常，跨工作区不可见", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const t2 = await ctx.register("other@test.dev");

    const put = await ctx.api(
      "PUT",
      "/api/term-mappings",
      { lang: "en", sourceText: "颜色", targetText: "Color" },
      t,
    );
    expect(put.status).toBe(200);
    expect(put.body.item.targetText).toBe("Color");

    // 同键覆盖更新
    const again = await ctx.api(
      "PUT",
      "/api/term-mappings",
      { lang: "en", sourceText: "颜色", targetText: "Colour" },
      t,
    );
    expect(again.body.item.targetText).toBe("Colour");

    const list = await ctx.api("GET", "/api/term-mappings", undefined, t);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].targetText).toBe("Colour");

    const other = await ctx.api("GET", "/api/term-mappings", undefined, t2);
    expect(other.body.items).toEqual([]);
    const denied = await ctx.api("DELETE", `/api/term-mappings/${put.body.item.id}`, undefined, t2);
    expect(denied.status).toBe(404);

    const del = await ctx.api("DELETE", `/api/term-mappings/${put.body.item.id}`, undefined, t);
    expect(del.body.ok).toBe(true);
  });

  it("认领时按刊登语言预翻选项与属性", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const store = await makeStore(ctx, t);

    for (const [sourceText, targetText] of [
      ["颜色", "Color"],
      ["红色", "Red"],
      ["材质", "Material"],
      ["棉", "Cotton"],
    ]) {
      await ctx.api("PUT", "/api/term-mappings", { lang: "en", sourceText, targetText }, t);
    }
    // 不匹配的 lang 不生效
    await ctx.api("PUT", "/api/term-mappings", { lang: "fr", sourceText: "尺码", targetText: "Taille" }, t);

    const { listing } = await collectAndClaim(ctx, t, store.id, "777");
    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.options.map((o: any) => o.name)).toEqual(["Color", "尺码"]);
    expect(cur.body.options[0].values).toEqual(["Red"]);
    expect(cur.body.variants[0].optionValues).toEqual(["Red", "M"]);
    expect(cur.body.descriptionHtml).toContain("Material");
    expect(cur.body.descriptionHtml).toContain("Cotton");
  });

  it("接受 AI 选项建议后学习词对，下次认领自动预翻", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const store = await makeStore(ctx, t);

    const { listing } = await collectAndClaim(ctx, t, store.id, "777");
    await drain(ctx);

    const sug = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    const options = sug.body.items.find((s: any) => s.field === "options");
    const decide = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      { decisions: [{ id: options.id, action: "accept" }] },
      t,
    );
    expect(decide.body.accepted).toBe(1);

    const list = await ctx.api("GET", "/api/term-mappings", undefined, t);
    const map = Object.fromEntries(list.body.items.map((m: any) => [m.sourceText, m.targetText]));
    expect(map).toMatchObject({ 颜色: "Color", 红色: "Red", 尺码: "Size" });
    // 源词=译文的不入库（M→M、L→L 被过滤）
    expect(map.M).toBeUndefined();
    expect(map.L).toBeUndefined();

    // 第二次认领同款：学到的词直接预翻
    const item2 = await ctx.api("POST", "/api/collect", harvest("888", "保温水杯二代"), t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item2.body.item.id], storeIds: [store.id] },
      t,
    );
    const list2 = await ctx.api("GET", "/api/listings?q=保温水杯二代", undefined, t);
    const cur2 = await ctx.api("GET", `/api/listings/${list2.body.items[0].id}`, undefined, t);
    expect(cur2.body.options.map((o: any) => o.name)).toEqual(["Color", "Size"]);
    expect(cur2.body.variants[0].optionValues).toEqual(["Red", "M"]);
  });
});
