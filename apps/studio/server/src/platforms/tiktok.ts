import type { ChannelIssue } from "@studio/shared";
import type { PlatformAdapter } from "./types.js";

// TODO(child-server-core): 按 docs/studio-phase0.md 的 TikTok Shop 拆解实现。
// 规则要点：标题 ≤80 字符为优（>80 告警）；图 ≥5 张建议、≥600px；
// 类目需映射到 TikTok 类目路径；品牌/证书类属性必填项；变体 ≤300；
// 发布落地常态为"审核中"(review)。
export const tiktokAdapter: PlatformAdapter = {
  id: "tiktok",
  name: "TikTok Shop",
  sites: ["US", "UK", "MY", "SG", "PH", "TH", "VN"],

  validateDraft(_input): ChannelIssue[] {
    throw new Error("not implemented");
  },

  async publish() {
    throw new Error("not implemented");
  },
};
