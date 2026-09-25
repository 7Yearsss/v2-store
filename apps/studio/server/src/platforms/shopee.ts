import type { ChannelIssue } from "@studio/shared";
import type { PlatformAdapter } from "./types.js";

// TODO(child-server-core): 按 docs/studio-phase0.md 的 Shopee 拆解实现。
// 规则要点（来自调研）：标题 ≤255 实际建议 ≤60；图 1–9 张、封面必有；
// 每类目必填属性 *；价格按站点币种；禁售词表；标题含 "official store" 类保留词告警。
export const shopeeAdapter: PlatformAdapter = {
  id: "shopee",
  name: "Shopee",
  sites: ["MY", "SG", "PH", "TH", "TW"],

  validateDraft(_input): ChannelIssue[] {
    throw new Error("not implemented");
  },

  async publish() {
    throw new Error("not implemented");
  },
};
