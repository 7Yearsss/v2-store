import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/services/imports.js";
import { setup } from "./helpers.js";

describe("importCsv", () => {
  it("3 行里 1 行坏 → created=2 errors=1", async () => {
    const { api, deps, close } = await setup();
    const csv = [
      "title,price,stock,sku,images,category",
      "测试连衣裙,29.9,100,SKU-001,https://a/1.jpg|https://a/2.jpg,女装/连衣裙",
      "坏行商品,abc,10,SKU-002,,女装",
      "测试耳机,59,20,SKU-003,https://c/1.jpg,3C数码/耳机",
    ].join("\n");
    const res = await api("POST", "/api/products/import", { csv });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(3);

    // 成功行落库：source=import + variants + 主稿已初始化
    const p = res.body.created[0];
    expect(p.source).toBe("import");
    expect(p.variants[0]).toMatchObject({ sku: "SKU-001", price: 29.9, stock: 100 });
    expect(p.images).toHaveLength(2);
    expect(p.sourceCategory).toBe("女装/连衣裙");
    const draft = await api("GET", `/api/products/${p.id}/draft`);
    expect(draft.status).toBe(200);
    expect(draft.body.fields.price).toBe(29.9);

    // 确认总数
    const rows = await deps.db.query.products.findMany();
    expect(rows).toHaveLength(2);
    await close();
  });

  it("无表头容忍（前两列=title,price）", async () => {
    const { api, close } = await setup();
    const res = await api("POST", "/api/products/import", {
      csv: "无表头商品A,19.9\n无表头商品B,29",
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.errors).toHaveLength(0);
    expect(res.body.created[1].variants[0].price).toBe(29);
    await close();
  });

  it("标题为空也算坏行", async () => {
    const { api, close } = await setup();
    const res = await api("POST", "/api/products/import", {
      csv: "title,price\n,9.9",
    });
    expect(res.body.created).toHaveLength(0);
    expect(res.body.errors).toHaveLength(1);
    await close();
  });
});

describe("productFromUrl", () => {
  it("1688 链接 201", async () => {
    const { api, close } = await setup();
    const res = await api("POST", "/api/products/from-url", {
      url: "https://detail.1688.com/offer/123456.html",
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("link");
    expect(res.body.images.length).toBeGreaterThanOrEqual(3);
    expect(res.body.variants.length).toBeGreaterThanOrEqual(2);
    await close();
  });

  it("taobao/tmall 也支持", async () => {
    const { api, close } = await setup();
    for (const url of [
      "https://item.taobao.com/item.htm?id=1",
      "https://detail.tmall.com/item.htm?id=2",
    ]) {
      const res = await api("POST", "/api/products/from-url", { url });
      expect(res.status).toBe(201);
      expect(res.body.source).toBe("link");
    }
    await close();
  });

  it("未知 host → 400", async () => {
    const { api, close } = await setup();
    const res = await api("POST", "/api/products/from-url", {
      url: "https://www.example.com/item/1",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("1688");
    await close();
  });
});

describe("seedDemo", () => {
  it("跑两次不重复（shops 仍 3）", async () => {
    const { deps, close } = await setup();
    await seedDemo(deps);
    await seedDemo(deps);
    const shopRows = await deps.db.query.shops.findMany();
    expect(shopRows).toHaveLength(3);
    expect(shopRows.filter((s) => s.authStatus === "expired")).toHaveLength(1);

    const productRows = await deps.db.query.products.findMany();
    expect(productRows).toHaveLength(6);
    const draftRows = await deps.db.query.listingDrafts.findMany();
    expect(draftRows).toHaveLength(6);
    await close();
  });
});
