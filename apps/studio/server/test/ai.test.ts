import { describe, expect, it } from "vitest";
import type { AiMode, DraftFields } from "@studio/shared";
import { runFieldAi } from "../src/services/ai.js";
import { setup } from "./helpers.js";

const fields: DraftFields = {
  images: ["https://img/1.png"],
  title: "2025夏季新款法式碎花连衣裙 收腰显瘦",
  bullets: [],
  description: "",
  attributes: { Material: "棉混纺" },
  price: 10,
  compareAtPrice: null,
  category: "女装/连衣裙",
  upc: null,
};

const baseInput = {
  productId: "p1",
  fields,
  productTitle: "2025夏季新款  法式碎花连衣裙   收腰显瘦中长裙",
  sourceCategory: "女装/连衣裙",
};

describe("runFieldAi mock（确定性）", () => {
  it("同输入两次返回一致", async () => {
    const { deps, close } = await setup();
    const input = { ...baseInput, field: "title" as const, mode: "generate" as const };
    const a = await runFieldAi(deps, input);
    const b = await runFieldAi(deps, input);
    expect(a).toEqual(b);
    await close();
  });

  it("title/generate 返回货源标题 + 类目末段", async () => {
    const { deps, close } = await setup();
    const r = await runFieldAi(deps, { ...baseInput, field: "title", mode: "generate" });
    expect(r.title).toContain("法式碎花连衣裙");
    expect(r.title).toContain("连衣裙");
    await close();
  });

  it("title/shorter 截到 40 字符内", async () => {
    const { deps, close } = await setup();
    const r = await runFieldAi(deps, { ...baseInput, field: "title", mode: "shorter" });
    expect(r.title!.length).toBeLessThanOrEqual(40);
    await close();
  });

  it("title/more_converting 前置卖点词", async () => {
    const { deps, close } = await setup();
    const r = await runFieldAi(deps, { ...baseInput, field: "title", mode: "more_converting" });
    expect(r.title).toMatch(/^(Hot Sale|2025 New) /);
    await close();
  });

  it("description/generate 返回模板段落", async () => {
    const { deps, close } = await setup();
    const r = await runFieldAi(deps, { ...baseInput, field: "description", mode: "generate" });
    expect(r.description).toContain("产品卖点");
    expect(r.description).toContain("售后");
    await close();
  });

  it.each(["shopee", "tiktok"] as const)(
    "description/channel_rewrite %s 改写风格",
    async (channel) => {
      const { deps, close } = await setup();
      const r = await runFieldAi(deps, {
        ...baseInput,
        field: "description",
        mode: "channel_rewrite",
        channel,
      });
      const plain = await runFieldAi(deps, { ...baseInput, field: "description", mode: "generate" });
      expect(r.description).toBeTruthy();
      expect(r.description).not.toBe(plain.description);
      if (channel === "tiktok") expect(r.description).toContain("小黄车");
      await close();
    },
  );

  it("bullets/generate 返回 4-5 条，attributes 优先", async () => {
    const { deps, close } = await setup();
    const r = await runFieldAi(deps, { ...baseInput, field: "bullets", mode: "generate" });
    expect(r.bullets!.length).toBeGreaterThanOrEqual(4);
    expect(r.bullets!.length).toBeLessThanOrEqual(5);
    expect(r.bullets![0]).toBe("Material: 棉混纺");
    await close();
  });

  it("attributes/category_fill 服装类目给 Material/Pattern/Sleeve", async () => {
    const { deps, close } = await setup();
    const r = await runFieldAi(deps, {
      ...baseInput,
      field: "attributes",
      mode: "category_fill",
    });
    expect(r.attributes).toMatchObject({ Material: expect.any(String), Pattern: expect.any(String), Sleeve: expect.any(String) });
    await close();
  });

  it("attributes/category_fill 电子类目给 Battery/Connectivity/Warranty", async () => {
    const { deps, close } = await setup();
    const r = await runFieldAi(deps, {
      ...baseInput,
      fields: { ...fields, category: "3C数码/耳机" },
      field: "attributes",
      mode: "category_fill",
    });
    expect(r.attributes).toMatchObject({
      Battery: expect.any(String),
      Connectivity: expect.any(String),
      Warranty: expect.any(String),
    });
    await close();
  });

  it("pricing/margin_suggest 固定公式", async () => {
    const { deps, close } = await setup();
    const r = await runFieldAi(deps, { ...baseInput, field: "pricing", mode: "margin_suggest" });
    expect(r.price).toBe(22); // 10 * 2.2
    const zero = await runFieldAi(deps, {
      ...baseInput,
      fields: { ...fields, price: 0 },
      field: "pricing",
      mode: "margin_suggest",
    });
    expect(zero.price).toBe(0);
    await close();
  });

  it("mode/field 任意组合都有返回（mock 兜底）", async () => {
    const { deps, close } = await setup();
    const modes: AiMode[] = [
      "generate",
      "shorter",
      "more_converting",
      "category_fill",
      "margin_suggest",
      "channel_rewrite",
    ];
    for (const mode of modes) {
      const r = await runFieldAi(deps, { ...baseInput, field: "title", mode });
      expect(r).toBeTruthy();
    }
    await close();
  });
});
