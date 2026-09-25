import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelCheck } from "@studio/shared";
import {
  createJob,
  createProduct,
  createShop,
  getJob,
  makeCtx,
  patchDraft,
  preview,
  retryAttempt,
  revokeShop,
  seedValidProduct,
  waitJobDone,
} from "./helpers.js";

let ctx: Awaited<ReturnType<typeof makeCtx>>;
beforeEach(async () => {
  ctx = await makeCtx();
});
afterEach(async () => {
  await ctx.close();
});

async function mkShop(platform: "shopee" | "tiktok", site: string, name: string) {
  const res = await createShop(ctx.api, { platform, site, name });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe("preview（channelCheck）", () => {
  it("过期店返回 auth_expired 且 ok:false", async () => {
    const productId = await seedValidProduct(ctx.api);
    const expired = await mkShop("shopee", "MY", "过期店");
    await revokeShop(ctx.api, expired);
    const good = await mkShop("shopee", "SG", "正常店");

    const res = await preview(ctx.api, productId, [expired, good]);
    expect(res.status).toBe(200);
    const checks: ChannelCheck[] = res.body.checks;
    const expiredCheck = checks.find((c) => c.shopId === expired)!;
    expect(expiredCheck.ok).toBe(false);
    expect(expiredCheck.issues).toContainEqual(
      expect.objectContaining({ code: "auth_expired", field: "auth", fixable: false }),
    );

    const goodCheck = checks.find((c) => c.shopId === good)!;
    expect(goodCheck.ok).toBe(true);
    expect(goodCheck.issues).toHaveLength(0);
  });

  it("正常店缺 Brand → missing_field(attributes.Brand)", async () => {
    // 不 PATCH attributes → Brand 缺失
    const p = await createProduct(ctx.api, {
      title: "缺品牌商品",
      images: ["https://img/1.png"],
      variants: [{ sku: "S1", price: 9.9 }],
      sourceCategory: "女装/T恤",
    });
    const shop = await mkShop("shopee", "MY", "店A");
    const res = await preview(ctx.api, p.body.id, [shop]);
    const check = res.body.checks[0]!;
    expect(check.ok).toBe(false);
    expect(check.issues).toContainEqual(
      expect.objectContaining({ code: "missing_field", field: "attributes.Brand" }),
    );
  });

  it("缺省 shopIds → 全部店铺都列（含过期店）", async () => {
    const productId = await seedValidProduct(ctx.api);
    const s1 = await mkShop("shopee", "MY", "店1");
    const s2 = await mkShop("tiktok", "US", "店2");
    await revokeShop(ctx.api, s2);
    // service 层缺省语义：直接调 channelCheck
    const { channelCheck } = await import("../src/services/publish.js");
    const checks = await channelCheck(ctx.deps, { productId });
    expect(checks.map((c) => c.shopId).sort()).toEqual([s1, s2].sort());
    expect(checks.find((c) => c.shopId === s2)!.issues[0]!.code).toBe("auth_expired");
  });

  it("tiktok 平台差异：标题 >80 超长、图 <5 缺、缺 UPC", async () => {
    const p = await createProduct(ctx.api, {
      title: "超长标题".repeat(30), // 120 字符 >80
      images: ["https://img/1.png"],
      variants: [{ sku: "S1", price: 9.9 }], // upc null → draft.upc null
      sourceCategory: "女装/T恤",
    });
    await patchDraft(ctx.api, p.body.id, { attributes: { Brand: "X" } });
    const shop = await mkShop("tiktok", "US", "TT店");
    const res = await preview(ctx.api, p.body.id, [shop]);
    const issues = res.body.checks[0]!.issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: "too_long", field: "title" }));
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "missing_field", field: "images" }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "missing_field", field: "upc", fixable: true }),
    );
  });

  it("禁售词：shopee 命中『高仿』、tiktok 命中『whatsapp』", async () => {
    const pid1 = await seedValidProduct(ctx.api, "高仿手表");
    const pid2 = await seedValidProduct(ctx.api, "best price whatsapp me");
    const shopeeShop = await mkShop("shopee", "MY", "SP店");
    const tiktokShop = await mkShop("tiktok", "US", "TT店");

    const r1 = await preview(ctx.api, pid1, [shopeeShop]);
    expect(r1.body.checks[0]!.issues).toContainEqual(
      expect.objectContaining({ code: "banned_term", field: "title" }),
    );
    const r2 = await preview(ctx.api, pid2, [tiktokShop]);
    expect(r2.body.checks[0]!.issues).toContainEqual(
      expect.objectContaining({ code: "banned_term", field: "title" }),
    );
  });
});

describe("publish job + runner", () => {
  it("drain 后 shopee attempt succeeded（SP- + remoteUrl），tiktok attempt review，job succeeded", async () => {
    const productId = await seedValidProduct(ctx.api);
    const shopeeShop = await mkShop("shopee", "MY", "SP店");
    const tiktokShop = await mkShop("tiktok", "US", "TT店");

    const created = await createJob(ctx.api, productId, [shopeeShop, tiktokShop]);
    expect(created.status).toBe(201);
    // runner 已自动唤醒，返回时可能已开始 drain——只断官非终态
    expect(["queued", "running"]).toContain(created.body.job.status);
    expect(created.body.job.fieldsSnapshot.title).toBe("测试商品 A");
    expect(created.body.attempts).toHaveLength(2);

    const detail = await waitJobDone(ctx.api, created.body.job.id);
    expect(detail.job.status).toBe("succeeded");

    const shopeeAtt = detail.attempts.find((a) => a.shopId === shopeeShop)!;
    expect(shopeeAtt.status).toBe("succeeded");
    expect(shopeeAtt.externalId).toMatch(/^SP-[0-9a-f]{8}$/);
    expect(shopeeAtt.remoteUrl).toBe(`https://shopee.my/product/${shopeeAtt.externalId}`);

    const tiktokAtt = detail.attempts.find((a) => a.shopId === tiktokShop)!;
    expect(tiktokAtt.status).toBe("review");
    expect(tiktokAtt.externalId).toMatch(/^TT-[0-9a-f]{8}$/);
    expect(tiktokAtt.remoteUrl).toBe(
      `https://seller.tiktokglobalshop.com/product/${tiktokAtt.externalId}`,
    );
  });

  it("externalId 确定性：同 product+shop 两次发布同 id", async () => {
    const productId = await seedValidProduct(ctx.api);
    const shop = await mkShop("shopee", "MY", "SP店");
    const j1 = await waitJobDone(ctx.api, (await createJob(ctx.api, productId, [shop])).body.job.id);
    const j2 = await waitJobDone(ctx.api, (await createJob(ctx.api, productId, [shop])).body.job.id);
    expect(j1.attempts[0]!.externalId).toBe(j2.attempts[0]!.externalId);
  });

  it("title 含 [FAIL] → 该店 attempt failed(platform_rejected)、其它店成功、job=partial_success", async () => {
    const productId = await seedValidProduct(ctx.api, "[FAIL] 测试商品");
    const shopeeShop = await mkShop("shopee", "MY", "SP店");
    const tiktokShop = await mkShop("tiktok", "US", "TT店");

    const created = await createJob(ctx.api, productId, [shopeeShop, tiktokShop]);
    const detail = await waitJobDone(ctx.api, created.body.job.id);

    expect(detail.job.status).toBe("partial_success");
    const shopeeAtt = detail.attempts.find((a) => a.shopId === shopeeShop)!;
    expect(shopeeAtt.status).toBe("failed");
    expect(shopeeAtt.error).toContain("平台拒绝");
    expect(shopeeAtt.issues).toContainEqual(
      expect.objectContaining({ code: "platform_rejected" }),
    );
    const tiktokAtt = detail.attempts.find((a) => a.shopId === tiktokShop)!;
    expect(tiktokAtt.status).toBe("review");
  });

  it("校验失败（过期店）直接 failed，不走到 publish", async () => {
    const productId = await seedValidProduct(ctx.api);
    const expired = await mkShop("shopee", "MY", "过期店");
    await revokeShop(ctx.api, expired);
    const created = await createJob(ctx.api, productId, [expired]);
    const detail = await waitJobDone(ctx.api, created.body.job.id);
    expect(detail.job.status).toBe("failed");
    const att = detail.attempts[0]!;
    expect(att.status).toBe("failed");
    expect(att.issues[0]!.code).toBe("auth_expired");
    expect(att.externalId).toBeNull();
  });

  it("全店失败 → job=failed", async () => {
    const productId = await seedValidProduct(ctx.api, "[FAIL] 全挂");
    const s1 = await mkShop("shopee", "MY", "SP1");
    const s2 = await mkShop("shopee", "SG", "SP2");
    const created = await createJob(ctx.api, productId, [s1, s2]);
    const detail = await waitJobDone(ctx.api, created.body.job.id);
    expect(detail.job.status).toBe("failed");
    expect(detail.attempts.every((a) => a.status === "failed")).toBe(true);
  });

  it("retryAttempt：failed → 新 attempt queued → drain 后 succeeded；非 failed 重试 → 400", async () => {
    const productId = await seedValidProduct(ctx.api, "[FAIL] 测试商品");
    const shopeeShop = await mkShop("shopee", "MY", "SP店");
    const created = await createJob(ctx.api, productId, [shopeeShop]);
    const detail = await waitJobDone(ctx.api, created.body.job.id);
    const failedAtt = detail.attempts[0]!;
    expect(failedAtt.status).toBe("failed");
    expect(detail.job.status).toBe("failed");

    // 修稿（去掉 [FAIL]）→ 重试：retry 跑当前主稿，快照仍留作创建时审计
    await patchDraft(ctx.api, productId, { title: "测试商品 A 修正版" });
    const retried = await retryAttempt(ctx.api, failedAtt.id);
    expect(retried.status).toBe(200);
    const newAtt = retried.body.attempts.find((a) => a.retryOf === failedAtt.id)!;
    // 新 attempt 以 queued 入队，drain 可能已跑完——只断它确实被重建了
    expect(newAtt.status).not.toBe("failed");

    const done = await waitJobDone(ctx.api, created.body.job.id);
    const retriedAtt = done.attempts.find((a) => a.retryOf === failedAtt.id)!;
    expect(retriedAtt.status).toBe("succeeded");
    expect(retriedAtt.externalId).toMatch(/^SP-/);
    // 旧 attempt 保持 failed 留档；聚合只看每店最新一条 → job succeeded
    expect(done.attempts.find((a) => a.id === failedAtt.id)!.status).toBe("failed");
    expect(done.job.status).toBe("succeeded");
    expect(done.job.fieldsSnapshot.title).toBe("[FAIL] 测试商品");

    // 非 failed attempt 重试 → 400
    const res = await retryAttempt(ctx.api, retriedAtt.id);
    expect(res.status).toBe(400);
  });

  it("listJobs 分页 + attempts 升序；audit 落 attempt.finish", async () => {
    const productId = await seedValidProduct(ctx.api);
    const shop = await mkShop("shopee", "MY", "SP店");
    await waitJobDone(ctx.api, (await createJob(ctx.api, productId, [shop])).body.job.id);
    await waitJobDone(ctx.api, (await createJob(ctx.api, productId, [shop])).body.job.id);

    const res = await ctx.api<{ status: number; body: { items: { job: { id: string } }[]; total: number } }>(
      "/api/publish/jobs?page=1",
    );
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(2);

    // audit：attempt.finish 落库（payload 含 status/externalId）
    const detail = await getJob(ctx.api, res.body.items[0]!.job.id);
    const attId = detail.body.attempts[0]!.id;
    const logs = await ctx.api<{
      status: number;
      body: { items: { action: string; payload: { status?: string; externalId?: string } }[] };
    }>(`/api/meta/audit-logs?entityType=attempt&entityId=${attId}`);
    expect(logs.body.items.length).toBeGreaterThan(0);
    expect(logs.body.items[0]!.action).toBe("attempt.finish");
    expect(logs.body.items[0]!.payload.status).toBe("succeeded");
    expect(logs.body.items[0]!.payload.externalId).toMatch(/^SP-/);
  });
});

describe("review 修复回归", () => {
  it("attempt 快照：首跑=job 冻结版；重试=补完字段的当前主稿", async () => {
    const productId = await seedValidProduct(ctx.api, "[FAIL] 快照商品");
    const shop = await mkShop("shopee", "MY", "SP店");
    const created = await createJob(ctx.api, productId, [shop]);
    const detail = await waitJobDone(ctx.api, created.body.job.id);
    const failedAtt = detail.attempts[0]!;
    // 首跑 attempt 携带 job 冻结快照
    expect(failedAtt.fieldsSnapshot?.title).toBe("[FAIL] 快照商品");

    await patchDraft(ctx.api, productId, { title: "修正后标题" });
    await retryAttempt(ctx.api, failedAtt.id);
    const done = await waitJobDone(ctx.api, created.body.job.id);
    const retriedAtt = done.attempts.find((a) => a.retryOf === failedAtt.id)!;
    // 重试 attempt 记录它实际发出去的版本（修正后主稿）
    expect(retriedAtt.fieldsSnapshot?.title).toBe("修正后标题");
    expect(retriedAtt.status).toBe("succeeded");
  });

  it("只允许重试该店最新一条 attempt", async () => {
    const productId = await seedValidProduct(ctx.api, "[FAIL] 两次失败");
    const shop = await mkShop("shopee", "MY", "SP店");
    const created = await createJob(ctx.api, productId, [shop]);
    const d1 = await waitJobDone(ctx.api, created.body.job.id);
    const first = d1.attempts[0]!;

    // 第一次重试仍失败（标题还含 [FAIL]）→ 产生更新的 attempt
    const r1 = await retryAttempt(ctx.api, first.id);
    expect(r1.status).toBe(200);
    const done = await waitJobDone(ctx.api, created.body.job.id);
    const second = done.attempts.find((a) => a.retryOf === first.id)!;
    expect(second.status).toBe("failed");

    // 再回头重试旧的那条 → 400（只能重试最新）
    const stale = await retryAttempt(ctx.api, first.id);
    expect(stale.status).toBe(400);
    // 最新那条可重试
    const r2 = await retryAttempt(ctx.api, second.id);
    expect(r2.status).toBe(200);
  });

  it("tiktok warn 项（标题>80、图<5）不阻塞：check.ok=true 且发布进入 review", async () => {
    const p = await createProduct(ctx.api, {
      title: "超长标题".repeat(30),
      images: ["https://img/1.png"],
      variants: [{ sku: "S1", price: 9.9, upc: "012345678905" }],
      sourceCategory: "女装/T恤",
    });
    await patchDraft(ctx.api, p.body.id, { attributes: { Brand: "X" } });
    const shop = await mkShop("tiktok", "US", "TT店");

    const res = await preview(ctx.api, p.body.id, [shop]);
    const check = res.body.checks[0]!;
    expect(check.ok).toBe(true);
    expect(check.issues.length).toBeGreaterThan(0);
    expect(check.issues.every((i) => i.severity === "warn")).toBe(true);

    const created = await createJob(ctx.api, p.body.id, [shop]);
    const detail = await waitJobDone(ctx.api, created.body.job.id);
    expect(detail.attempts[0]!.status).toBe("review");
    expect(detail.job.status).toBe("succeeded");
  });

  it("软删除店铺：列表/对照/新建 job 排除，历史 attempt 保留", async () => {
    const productId = await seedValidProduct(ctx.api);
    const shop = await mkShop("shopee", "MY", "要删的店");
    const created = await createJob(ctx.api, productId, [shop]);
    const detail = await waitJobDone(ctx.api, created.body.job.id);
    expect(detail.attempts[0]!.status).toBe("succeeded");

    // DELETE → 软删除
    const del = await ctx.api<{ status: number }>(`/api/shops/${shop}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    // 店铺列表不再返回
    const list = await ctx.api<{ status: number; body: { items: { id: string }[] } }>("/api/shops");
    expect(list.body.items.some((s) => s.id === shop)).toBe(false);

    // 对照预览缺省集合也不含已删店
    const { channelCheck } = await import("../src/services/publish.js");
    const checks = await channelCheck(ctx.deps, { productId });
    expect(checks.some((c) => c.shopId === shop)).toBe(false);

    // 新建 job 指定已删店 → 400
    const bad = await createJob(ctx.api, productId, [shop]);
    expect(bad.status).toBe(400);

    // 历史 job 的 attempt 仍可查
    const again = await getJob(ctx.api, created.body.job.id);
    expect(again.body.attempts[0]!.status).toBe("succeeded");
    expect(again.body.attempts[0]!.externalId).toMatch(/^SP-/);
  });
});
