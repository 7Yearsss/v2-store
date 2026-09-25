import type { Deps } from "../context.js";
import type { AiField, AiMode, DraftFields, PlatformId } from "@studio/shared";

// ============================================================
// child-ai-seed 拥有本文件实现。签名冻结。
// 语义：
// - runFieldAi：字段级 AI 动作。配了 deps.config.ai 走真 LLM
//   （OpenAI 兼容 POST {baseUrl}/chat/completions），否则走确定性 mock
//   生成器。返回值是要写进 fields 的 patch（不写库——路由层调用
//   patchDraft 落库 + audit）。
// - mode 语义：
//   generate        按货源主数据生成该字段
//   shorter         标题更短
//   more_converting 更转化的标题写法
//   category_fill   按 fields.category 补 attributes
//   margin_suggest  按平台费率倒推建议价（返回 {price}）
//   channel_rewrite 按 channel 平台语气改写 description
// - mock 生成器必须确定性（同输入同输出），便于测试。
// ============================================================

export declare function runFieldAi(
  deps: Deps,
  input: {
    productId: string;
    field: AiField;
    mode: AiMode;
    channel?: PlatformId;
    fields: DraftFields;
    productTitle: string;
    sourceCategory: string | null;
  },
): Promise<Partial<DraftFields>>;
