import { createApp } from "../src/app.js";
import type { Deps } from "../src/context.js";
import { openDb } from "../src/db/client.js";

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
