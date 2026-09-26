import type { PlatformId } from "@studio/shared";
import { badRequest } from "../lib/errors.js";
import { shopeeAdapter } from "./shopee.js";
import { tiktokAdapter } from "./tiktok.js";
import type { PlatformAdapter } from "./types.js";

const adapters: Record<PlatformId, PlatformAdapter> = {
  shopee: shopeeAdapter,
  tiktok: tiktokAdapter,
};

export function adapterFor(id: PlatformId): PlatformAdapter {
  const a = adapters[id];
  if (!a) throw badRequest(`未知平台 ${id}`);
  return a;
}

export function platformMetas() {
  return Object.values(adapters).map(({ id, name, sites }) => ({ id, name, sites }));
}
