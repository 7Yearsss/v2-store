import { afterEach, describe, expect, it } from "vitest";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, json, setup, type FakeFetch } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const AI_URL = "https://ai.test/v1/chat/completions";

/** AI reply with a channelAttributes proposal mapping 材质 → Material (choice). */
const AI_REPLY = {
  title: "Cotton T-Shirt",
  channelAttributes: [
    {
      sourceName: "材质",
      sourceValue: "棉",
      attrId: "gid://shopify/TaxonomyChoiceListAttribute/material",
      attrName: "Material",
      value: "cotton", // 大小写不敏感 → 规范化回 "Cotton"
    },
    {
      sourceName: "风格",
      sourceValue: "简约",
      attrId: "gid://shopify/TaxonomyAttribute/pattern",
      attrName: "Pattern",
      value: "Solid",
    },
    // 非法 attrId 应被丢弃
    { sourceName: "x", attrId: "bogus", attrName: "Bogus", value: "v" },
  ],
};

function fakeAll(aiReply: unknown = AI_REPLY): FakeFetch {
  const shopify = fakeShopify();
  return (url, init) => {
    if (url === AI_URL) {
      return json({ choices: [{ message: { content: JSON.stringify(aiReply) } }] });
    }
    return shopify(url, init);
  };
}

function enableAi(c: Awaited<ReturnType<typeof setup>>) {
  c.deps.config.ai = { baseUrl: "https://ai.test/v1", apiKey: "k", model: "m" };
}

async function storeAndClaim(c: Awaited<ReturnType<typeof setup>>, t: string, offerId: string) {
  const store = await c.api(
    "POST",
    "/api/stores/shopify",
    { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
    t,
  );
  const item = await c.api("POST", "/api/collect", harvest(offerId, "纯棉T恤"), t);
  await c.api(
    "POST",
    "/api/source-items/claim",
    { ids: [item.body.item.id], storeIds: [store.body.id] },
    t,
  );
  const list = await c.api("GET", "/api/listings", undefined, t);
  return { store: store.body, listing: list.body.items[0] };
}

const drain = async (c: Awaited<ReturnType<typeof setup>>) => {
  while (await runOnce(c.deps, jobHandlers)) {
    /* drain */
  }
};

describe("属性映射", () => {
  it("映射表 CRUD + 跨工作区隔离", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const t2 = await ctx.register("other@test.dev");

    const put = await ctx.api(
      "PUT",
      "/api/attribute-mappings",
      {
        channel: "shopify",
        sourceName: "材质",
        channelAttrId: "gid://shopify/TaxonomyChoiceListAttribute/material",
        channelAttrName: "Material",
      },
      t,
    );
    expect(put.status).toBe(200);
    expect(put.body.sourceName).toBe("材质");

    // 同名覆盖
    const put2 = await ctx.api(
      "PUT",
      "/api/attribute-mappings",
      {
        channel: "shopify",
        sourceName: "材质",
        channelAttrId: "gid://shopify/TaxonomyAttribute/pattern",
        channelAttrName: "Pattern",
      },
      t,
    );
    expect(put2.body.channelAttrName).toBe("Pattern");

    const list = await ctx.api("GET", "/api/attribute-mappings", undefined, t);
    expect(list.body.items.length).toBe(1);
    const other = await ctx.api("GET", "/api/attribute-mappings", undefined, t2);
    expect(other.body.items.length).toBe(0);

    // 跨工作区删除别人的映射 → 404
    const del = await ctx.api(
      "DELETE",
      `/api/attribute-mappings/${put.body.id}`,
      undefined,
      t2,
    );
    expect(del.status).toBe(404);
    const ok = await ctx.api(
      "DELETE",
      `/api/attribute-mappings/${put.body.id}`,
      undefined,
      t,
    );
    expect(ok.status).toBe(200);
  });

  it("已映射属性名认领时自动套用 channelAttributes", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    await ctx.api(
      "PUT",
      "/api/attribute-mappings",
      {
        channel: "shopify",
        sourceName: "材质",
        channelAttrId: "gid://shopify/TaxonomyChoiceListAttribute/material",
        channelAttrName: "Material",
      },
      t,
    );
    const { listing } = await storeAndClaim(ctx, t, "attr-o1");
    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    // harvest() 里有 材质:棉
    const mat = cur.body.channelAttributes?.find(
      (a: any) => a.attrId === "gid://shopify/TaxonomyChoiceListAttribute/material",
    );
    expect(mat).toBeTruthy();
    expect(mat.name).toBe("Material");
    expect(mat.value).toBe("棉");
  });

  it("AI 提案 attributes → 接受后写刊登 + 学映射 → 下次认领自动套用", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const { listing } = await storeAndClaim(ctx, t, "attr-o2");

    // 未确认类目时不产生属性提案
    await drain(ctx);
    let res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    expect(res.body.items.some((s: any) => s.field === "attributes")).toBe(false);

    // 手动确认类目 → 重新跑 AI → 产出属性提案（fakeShopify 提供类目属性）
    await ctx.api(
      "POST",
      `/api/listings/${listing.id}/category`,
      {
        channelCategoryId: "gid://shopify/TaxonomyCategory/c1",
        channelCategoryName: "Apparel > Outerwear > Coats",
        remember: false,
      },
      t,
    );
    await ctx.api("POST", `/api/listings/${listing.id}/ai-enhance`, undefined, t);
    await drain(ctx);

    res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    const sug = res.body.items.find((s: any) => s.field === "attributes");
    expect(sug).toBeTruthy();
    // 非法 attrId 被过滤，choice 值规范化为 "Cotton"
    expect(sug.value.attributes.length).toBe(2);
    expect(sug.value.attributes[0].value).toBe("Cotton");

    const decide = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      { decisions: [{ id: sug.id, action: "accept" }] },
      t,
    );
    expect(decide.body.accepted).toBe(1);

    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.channelAttributes.length).toBe(2);
    expect(cur.body.channelAttributes[0].name).toBe("Material");
    expect(cur.body.channelAttributes[0].value).toBe("Cotton");

    // 学习到映射表
    const maps = await ctx.api("GET", "/api/attribute-mappings", undefined, t);
    expect(maps.body.items.length).toBe(2);
    expect(maps.body.items.some((m: any) => m.sourceName === "材质")).toBe(true);

    // 新认领自动套用学到的映射
    const { listing: listing2 } = await storeAndClaim(ctx, t, "attr-o3");
    const cur2 = await ctx.api("GET", `/api/listings/${listing2.id}`, undefined, t);
    expect(
      cur2.body.channelAttributes.some(
        (a: any) => a.attrId === "gid://shopify/TaxonomyChoiceListAttribute/material",
      ),
    ).toBe(true);
  });

  it("发布把 choice 属性写进 Shopify 标准 metafield（metaobject 引用）", async () => {
    const captured: Array<{ key: string; namespace: string; value: string; ownerId: string }> =
      [];
    ctx = await setup(fakeShopify({ capturedMetafields: captured }));
    const t = await ctx.register();
    // 术语映射先铺：认领时属性值 棉 → Cotton（与 taxonomy 候选值一致）
    await ctx.api(
      "PUT",
      "/api/term-mappings",
      { lang: "en", sourceText: "棉", targetText: "Cotton" },
      t,
    );
    await ctx.api(
      "PUT",
      "/api/attribute-mappings",
      {
        channel: "shopify",
        sourceName: "材质",
        channelAttrId: "gid://shopify/TaxonomyChoiceListAttribute/material",
        channelAttrName: "Material",
      },
      t,
    );
    const { listing } = await storeAndClaim(ctx, t, "attr-pub1");
    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.channelAttributes[0]?.value).toBe("Cotton");

    // 确认类目后发布
    await ctx.api(
      "POST",
      `/api/listings/${listing.id}/category`,
      {
        channelCategoryId: "gid://shopify/TaxonomyCategory/c1",
        channelCategoryName: "Apparel > Outerwear > Coats",
        remember: false,
      },
      t,
    );
    const pub = await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    expect(pub.status).toBe(200);
    await drain(ctx);

    const mf = captured.find((m) => m.key === "material");
    expect(mf).toBeTruthy();
    expect(mf!.namespace).toBe("shopify");
    expect(mf!.ownerId).toBe("gid://shopify/Product/42");
    expect(JSON.parse(mf!.value)[0]).toMatch(/^gid:\/\/shopify\/Metaobject\//);

    const done = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(done.body.status).toBe("published");
  });

  it("非候选值 / 无映射模板的属性写入跳过并告警，不阻塞发布", async () => {
    const captured: Array<{ key: string }> = [];
    ctx = await setup(fakeShopify({ capturedMetafields: captured }));
    const t = await ctx.register();
    await ctx.api(
      "PUT",
      "/api/attribute-mappings",
      {
        channel: "shopify",
        sourceName: "材质",
        channelAttrId: "gid://shopify/TaxonomyChoiceListAttribute/material",
        channelAttrName: "Material",
      },
      t,
    );
    const { listing } = await storeAndClaim(ctx, t, "attr-pub2");
    // 值是原文「棉」，匹配不到 taxonomy 候选值 → 跳过并告警
    await ctx.api(
      "POST",
      `/api/listings/${listing.id}/category`,
      {
        channelCategoryId: "gid://shopify/TaxonomyCategory/c1",
        channelCategoryName: "Coats",
        remember: false,
      },
      t,
    );
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    await drain(ctx);
    expect(captured.length).toBe(0);
    const done = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(done.body.status).toBe("published");
    expect(done.body.lastError?.includes("非标准候选值")).toBe(true);
  });

  it("类目属性端点：懒拉取 + 缓存 + 跨工作区店铺 404", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const t2 = await ctx.register("other@test.dev");
    const store = await ctx.api(
      "POST",
      "/api/stores/shopify",
      { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
      t,
    );
    const catId = encodeURIComponent("gid://shopify/TaxonomyCategory/c1");
    const res = await ctx.api(
      "GET",
      `/api/stores/${store.body.id}/categories/${catId}/attributes`,
      undefined,
      t,
    );
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    expect(res.body.items[0].kind).toBe("choice");

    // 二次调用走缓存（fakeShopify 不提供计数断言，至少结果一致）
    const again = await ctx.api(
      "GET",
      `/api/stores/${store.body.id}/categories/${catId}/attributes`,
      undefined,
      t,
    );
    expect(again.body.items.length).toBe(2);

    const cross = await ctx.api(
      "GET",
      `/api/stores/${store.body.id}/categories/${catId}/attributes`,
      undefined,
      t2,
    );
    expect(cross.status).toBe(404);
  });
});
