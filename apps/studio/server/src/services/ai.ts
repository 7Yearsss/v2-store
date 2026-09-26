import type { Deps } from "../context.js";
import type { AiField, AiMode, DraftFields, PlatformId } from "@studio/shared";
import { buildPrompt, parseAiJson } from "../ai/prompt.js";
import { mockFieldAi } from "../ai/mock.js";

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

const AI_TIMEOUT_MS = 20_000;

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
}

/** 真 LLM 链路；任何失败（非 2xx / 超时 / 解析失败）返回 null → 降级 mock。 */
async function callLlm(
  config: NonNullable<Deps["config"]["ai"]>,
  input: Parameters<typeof runFieldAi>[1],
): Promise<Partial<DraftFields> | null> {
  const { system, user } = buildPrompt(input);
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as ChatCompletion;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  return parseAiJson(input.field, content);
}

export async function runFieldAi(
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
): Promise<Partial<DraftFields>> {
  if (deps.config.ai) {
    try {
      const patch = await callLlm(deps.config.ai, input);
      if (patch) return patch;
    } catch {
      // 超时/网络失败 → 静默降级，UI 不卡死
    }
  }
  return mockFieldAi(input);
}
