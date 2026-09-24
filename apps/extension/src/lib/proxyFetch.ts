/** Route page-side HTTP through the background service worker (CORS bypass + uniform errors). */

export interface ProxyFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

export function proxyFetch(
  url: string,
  opts: ProxyFetchOptions = {},
): Promise<ProxyFetchResult> {
  const { method = "GET", headers, body } = opts;
  const serialized = body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        { type: "PROXY_FETCH", data: { url, method, headers, body: serialized } },
        (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || "background 未响应"));
            return;
          }
          if (!resp) {
            reject(new Error("background 未处理 PROXY_FETCH（请重新加载扩展）"));
            return;
          }
          resolve(resp as ProxyFetchResult);
        },
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export async function proxyFetchJson<T = any>(
  url: string,
  opts: ProxyFetchOptions = {},
): Promise<T> {
  const res = await proxyFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body) as T;
}
