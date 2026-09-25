import type { Deps } from "../context.js";

/**
 * Minimal OpenAI-compatible chat client (works against new-api relays and
 * api.openai.com alike). Uses deps.fetch so tests can stub the transport.
 */

export class AiError extends Error {}

/** Extract the first JSON object/array from a model reply (tolerates fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1]! : text).trim();
  const start = raw.search(/[{[]/);
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  if (start < 0 || end <= start) throw new AiError("AI 响应中没有 JSON");
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new AiError("AI 响应不是合法 JSON");
  }
}

export async function chatJson(
  deps: Deps,
  opts: { system: string; user: string; timeoutMs?: number },
): Promise<unknown> {
  const ai = deps.config.ai;
  if (!ai) throw new AiError("未配置 AI（AI_BASE_URL / AI_API_KEY）");
  const res = await deps.fetch(`${ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ai.apiKey}`,
    },
    body: JSON.stringify({
      model: ai.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AiError(`AI 请求失败 (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new AiError("AI 响应为空");
  return extractJson(content);
}
