import { afterEach, describe, expect, it } from "vitest";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { harvest, setup } from "./helpers.js";
import { fakeShopify } from "./fakeShopify.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const SRC = "https://cbu01.alicdn.com/a.jpg";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

async function upload(t: string, sourceUrl: string, bytes: Uint8Array) {
  const res = await ctx!.app.request(`/api/media/upload?sourceUrl=${encodeURIComponent(sourceUrl)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/octet-stream" },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return { status: res.status, body: await res.json() };
}

describe("media", () => {
  it("stores uploads deduped by content and serves them to the owner only", async () => {
    ctx = await setup();
    const a = await ctx.register("a@test.dev");
    const b = await ctx.register("b@test.dev");
    const first = await upload(a, SRC, JPEG);
    expect(first.status).toBe(201);
    const again = await upload(a, "https://cbu01.alicdn.com/other-name.jpg", JPEG);
    expect(again.body.id).toBe(first.body.id);

    const own = await ctx.app.request(first.body.url, { headers: { Authorization: `Bearer ${a}` } });
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(JPEG);
    const other = await ctx.app.request(first.body.url, { headers: { Authorization: `Bearer ${b}` } });
    expect(other.status).toBe(404);
  });

  it("rejects non-images", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const res = await upload(t, SRC, new TextEncoder().encode("<html>"));
    expect(res.status).toBe(422);
  });

  it("reports missing images and swaps in our copy for display", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const item = (await ctx.api("POST", "/api/collect", harvest("555"), t)).body.item;
    expect(item.images).toEqual([SRC]); // collect response keeps source URLs for the uploader
    expect((await ctx.api("POST", "/api/media/missing", { urls: [SRC] }, t)).body.missing).toEqual([SRC]);

    const up = await upload(t, SRC, JPEG);
    expect((await ctx.api("POST", "/api/media/missing", { urls: [SRC] }, t)).body.missing).toEqual([]);
    const list = await ctx.api("GET", "/api/source-items", undefined, t);
    expect(list.body.items[0].images).toEqual([up.body.url]);
  });

  it("fetches missing images server-side in the fallback job", async () => {
    ctx = await setup(fakeShopify({ sourceImages: { [SRC]: JPEG } }));
    const t = await ctx.register();
    await ctx.api("POST", "/api/collect", harvest("556"), t);
    // job is delayed to give the extension time; run it now
    const { jobs } = await import("../src/db/schema.js");
    await ctx.deps.db.update(jobs).set({ runAt: new Date(0) });
    expect(await runOnce(ctx.deps, jobHandlers)).toBe(true);
    expect((await ctx.api("POST", "/api/media/missing", { urls: [SRC] }, t)).body.missing).toEqual([]);
  });
});

describe("publishing images to Shopify", () => {
  async function claimAndPublish(t: string) {
    const store = await ctx!.api(
      "POST",
      "/api/stores/shopify",
      { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
      t,
    );
    const item = await ctx!.api("POST", "/api/collect", harvest("777"), t);
    await ctx!.api("POST", "/api/source-items/claim", { ids: [item.body.item.id], storeIds: [store.body.id] }, t);
    const listing = (await ctx!.api("GET", "/api/listings", undefined, t)).body.items[0];
    await ctx!.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    // skip the delayed media job; run the publish job
    const { jobs } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await ctx!.deps.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.type, "media.fetchMissing"));
    await runOnce(ctx!.deps, jobHandlers);
    return (await ctx!.api("GET", `/api/listings/${listing.id}`, undefined, t)).body;
  }

  it("uploads our copy via staged upload instead of the source URL", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    await upload(t, "https://cbu01.alicdn.com/a.jpg", JPEG);
    const done = await claimAndPublish(t);
    expect(done.status).toBe("published");
    expect(done.lastError).toBeNull();

    const staged = ctx.calls.find((c) => c.url === "https://staged.example/upload/0")!;
    expect(staged.body).toBeInstanceOf(FormData);
    const form = staged.body as FormData;
    expect(form.get("key")).toBe("k0");
    expect(form.get("file")).toBeInstanceOf(Blob);

    const productSet = ctx.calls.find((c) => c.body?.query?.includes("productSet"))!;
    expect(productSet.body.variables.input.files).toEqual([
      { originalSource: "https://staged.example/resource/0", contentType: "IMAGE" },
    ]);
  });

  it("falls back to the source URL and warns when no copy can be obtained", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const done = await claimAndPublish(t);
    expect(done.status).toBe("published");
    expect(done.lastError).toContain("1 张图片未能转存");
    const productSet = ctx.calls.find((c) => c.body?.query?.includes("productSet"))!;
    expect(productSet.body.variables.input.files[0].originalSource).toBe(SRC);
  });

  it("surfaces Shopify media processing failures", async () => {
    ctx = await setup(fakeShopify({ mediaStatus: "FAILED" }));
    const t = await ctx.register();
    await upload(t, SRC, JPEG);
    const done = await claimAndPublish(t);
    expect(done.status).toBe("published");
    expect(done.lastError).toContain("图片处理失败");
  });
});
