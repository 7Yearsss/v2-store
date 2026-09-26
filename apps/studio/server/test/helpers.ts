import type { DraftFields, PlatformId, PublishJobDetail } from "@studio/shared";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import type { Deps } from "../src/context.js";
import { startPublishRunner } from "../src/services/publish.js";

/** 轻量上下文（无 publish runner）——ai/imports 测试用。 */
export async function setup() {
  const handle = await openDb({ pgliteDir: "memory://" });
  const deps: Deps = {
    db: handle.db,
    config: { mock: { publishDelayMs: 0 } },
    actor: "test",
  };
  const app = createApp(deps);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { deps, app, api, close: handle.close };
}

/** 内存 PGlite + createApp + app.request 的最小测试上下文；
 *  带一个已启动的 publish runner（publishDelayMs=0 → 50ms 轮询）。 */
export async function makeCtx(opts: { publishDelayMs?: number } = {}) {
  const handle = await openDb({ pgliteDir: "memory://" });
  const deps: Deps = {
    db: handle.db,
    config: { mock: { publishDelayMs: opts.publishDelayMs ?? 0 } },
    actor: "test",
  };
  const app = createApp(deps);
  const stopRunner = startPublishRunner(deps);

  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await app.request(path, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    const body = res.status === 204 ? null : await res.json();
    return { status: res.status, body } as T;
  };

  return {
    deps,
    app,
    api,
    async close() {
      stopRunner();
      await handle.close();
    },
  };
}

export type Api = Awaited<ReturnType<typeof makeCtx>>["api"];
export type ApiRes<T> = { status: number; body: T };

export function createShop(
  api: Api,
  input: { platform: PlatformId; site: string; name: string },
) {
  return api<ApiRes<{ id: string }>>("/api/shops", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeShop(api: Api, id: string) {
  return api<ApiRes<unknown>>(`/api/shops/${id}/revoke`, { method: "POST" });
}

export function createProduct(
  api: Api,
  input: {
    title: string;
    images?: string[];
    variants?: { sku: string; price: number; stock?: number; upc?: string | null }[];
    sourceCategory?: string | null;
  },
) {
  return api<ApiRes<{ id: string }>>("/api/products", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchDraft(api: Api, productId: string, patch: Partial<DraftFields>) {
  return api<ApiRes<unknown>>(`/api/products/${productId}/draft`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function preview(api: Api, productId: string, shopIds: string[]) {
  return api<ApiRes<{ checks: import("@studio/shared").ChannelCheck[] }>>(
    "/api/publish/preview",
    { method: "POST", body: JSON.stringify({ productId, shopIds }) },
  );
}

export function createJob(api: Api, productId: string, shopIds: string[]) {
  return api<ApiRes<PublishJobDetail>>("/api/publish/jobs", {
    method: "POST",
    body: JSON.stringify({ productId, shopIds }),
  });
}

export function getJob(api: Api, id: string) {
  return api<ApiRes<PublishJobDetail>>(`/api/publish/jobs/${id}`);
}

export function retryAttempt(api: Api, attemptId: string) {
  return api<ApiRes<PublishJobDetail>>(`/api/publish/attempts/${attemptId}/retry`, {
    method: "POST",
  });
}

/** 轮询到 job 终态（succeeded/partial_success/failed），超时视为失败。 */
export async function waitJobDone(
  api: Api,
  jobId: string,
  timeoutMs = 8000,
): Promise<PublishJobDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await getJob(api, jobId);
    if (res.status !== 200) throw new Error(`getJob ${res.status}`);
    if (["succeeded", "partial_success", "failed"].includes(res.body.job.status)) {
      return res.body;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} 未在 ${timeoutMs}ms 内收敛（仍 ${res.body.job.status}）`);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** 建一个两平台校验都能过的商品（补齐 Brand/UPC/类目/5 图）。 */
export async function seedValidProduct(api: Api, title = "测试商品 A") {
  const p = await createProduct(api, {
    title,
    images: ["https://img/1.png", "https://img/2.png", "https://img/3.png", "https://img/4.png", "https://img/5.png"],
    variants: [{ sku: "S1", price: 12.5, stock: 10, upc: "012345678905" }],
    sourceCategory: "女装/T恤",
  });
  const productId = p.body.id;
  await patchDraft(api, productId, {
    attributes: { Brand: "测试牌" },
    bullets: ["透气", "快干"],
    description: "一件测试用 T 恤",
  });
  return productId;
}
