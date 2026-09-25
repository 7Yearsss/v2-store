import type { ChannelPlatform } from "@caiji/shared";
import { shopifyAdapter } from "./shopify/adapter.js";
import type { ChannelAdapter } from "./types.js";

const adapters: Record<ChannelPlatform, ChannelAdapter> = {
  shopify: shopifyAdapter,
};

export function adapterFor(platform: ChannelPlatform): ChannelAdapter {
  return adapters[platform];
}

export { ChannelError } from "./types.js";
