import { createApp } from "../src/app.js";
import type { Deps } from "../src/context.js";
import { openDb } from "../src/db/client.js";
import { MemoryStore } from "../src/lib/blobStore.js";
import { SecretBox } from "../src/lib/crypto.js";

export type FakeFetch = (url: string, init: RequestInit) => Promise<Response> | Response;

export async function setup(fakeFetch?: FakeFetch) {
  const handle = await openDb({ pgliteDir: "memory://" });
  const calls: Array<{ url: string; body: any }> = [];
  const deps: Deps = {
    db: handle.db,
    secrets: new SecretBox(),
    blobs: new MemoryStore(),
    config: {
      appUrl: "http://localhost:5173",
      sessionTtlDays: 30,
      secureCookies: false,
      shopify: {
        apiKey: "key",
        apiSecret: "secret",
        scopes: "write_products",
        apiVersion: "2026-07",
      },
    },
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      let body: any = init.body;
      try {
        body = typeof body === "string" ? JSON.parse(body) : body;
      } catch {
        /* form body */
      }
      calls.push({ url, body });
      if (!fakeFetch) throw new Error(`unexpected fetch ${url}`);
      return fakeFetch(url, init);
    }) as typeof fetch,
  };
  const app = createApp(deps);

  /** JSON request helper carrying a bearer token. */
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };

  /** Register a user and return its session token (from the cookie). */
  const register = async (email = "a@test.dev") => {
    const res = await api("POST", "/api/auth/register", {
      email,
      password: "password123",
      name: email.split("@")[0],
    });
    const token = res.headers.get("set-cookie")?.match(/sid=([^;]+)/)?.[1];
    if (!token) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
    return token;
  };

  return { app, deps, api, register, calls, close: handle.close };
}

export function offerHtml(offerId: string, title: string) {
  const data = {
    globalData: {
      offerBaseInfo: { subject: title, offerId, imageList: ["//cbu01.alicdn.com/a.jpg"] },
      skuModel: {
        skuProps: [{ prop: "颜色" }, { prop: "尺码" }],
        skuInfoMap: {
          "红色&gt;M": { specId: "s1", price: "10.5", canBookCount: 100 },
          "红色&gt;L": { specId: "s2", price: "11", canBookCount: 50 },
        },
      },
      productFeatureList: [{ name: "材质", value: "棉" }],
    },
  };
  return `<html><script>window.__INIT_DATA = ${JSON.stringify(data)};</script></html>`;
}

export function harvest(offerId: string, title = "测试商品") {
  return {
    sourceInfo: {
      itemUrl: `https://detail.1688.com/offer/${offerId}.html`,
      itemId: offerId,
      source: "1688",
    },
    pageContent: offerHtml(offerId, title),
    collectedAt: new Date().toISOString(),
  };
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
