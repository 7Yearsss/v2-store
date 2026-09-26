import type { Deps } from "../context.js";
import { aiUsage } from "../db/schema.js";

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

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export async function chatJson(
  deps: Deps,
  opts: { system: string; user: string; timeoutMs?: number },
): Promise<{ data: unknown; usage: ChatUsage }> {
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
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new AiError("AI 响应为空");
  return {
    data: extractJson(content),
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
  };
}

/**
 * chatJson + ai_usage 计量：成功记 tokens，失败记 error 行再抛出。
 * meta.listingId 可空（类目建议等不绑定刊登的调用）。
 */
export async function meteredChatJson(
  deps: Deps,
  meta: { workspaceId: string; listingId?: string | null },
  opts: { system: string; user: string; timeoutMs?: number },
): Promise<{ data: unknown; usage: ChatUsage }> {
  const model = deps.config.ai?.model ?? "";
  try {
    const res = await chatJson(deps, opts);
    await deps.db.insert(aiUsage).values({
      workspaceId: meta.workspaceId,
      listingId: meta.listingId ?? null,
      model,
      ...res.usage,
      status: "ok",
    });
    return res;
  } catch (e) {
    await deps.db
      .insert(aiUsage)
      .values({
        workspaceId: meta.workspaceId,
        listingId: meta.listingId ?? null,
        model,
        status: "error",
        error: e instanceof Error ? e.message.slice(0, 500) : String(e),
      })
      .catch(() => {});
    throw e;
  }
}

/** OpenAI-compatible image edit (POST /images/edits, multipart). Returns edited bytes. */
export async function editImage(
  deps: Deps,
  opts: { image: Uint8Array; contentType: string; prompt: string; timeoutMs?: number },
): Promise<Uint8Array> {
  const ai = deps.config.ai;
  if (!ai) throw new AiError("未配置 AI（AI_BASE_URL / AI_API_KEY）");
  const form = new FormData();
  form.set("model", ai.imageModel);
  form.set("prompt", opts.prompt);
  form.set("size", "1024x1024");
  form.set(
    "image",
    new Blob([opts.image as BlobPart], { type: opts.contentType }),
    `image.${opts.contentType.split("/")[1] ?? "png"}`,
  );
  const res = await deps.fetch(`${ai.baseUrl}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ai.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AiError(`图片 AI 请求失败 (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = data.data?.[0];
  if (first?.b64_json) return new Uint8Array(Buffer.from(first.b64_json, "base64"));
  if (first?.url) {
    const img = await deps.fetch(first.url);
    if (img.ok) return new Uint8Array(await img.arrayBuffer());
  }
  throw new AiError("图片 AI 响应里没有图像数据");
}

/** editImage + ai_usage 计量（图像接口无 token 计数，记调用成败）。 */
export async function meteredEditImage(
  deps: Deps,
  meta: { workspaceId: string; listingId?: string | null },
  opts: { image: Uint8Array; contentType: string; prompt: string; timeoutMs?: number },
): Promise<Uint8Array> {
  const model = `image:${deps.config.ai?.imageModel ?? ""}`;
  try {
    const bytes = await editImage(deps, opts);
    await deps.db.insert(aiUsage).values({
      workspaceId: meta.workspaceId,
      listingId: meta.listingId ?? null,
      model,
      status: "ok",
    });
    return bytes;
  } catch (e) {
    await deps.db
      .insert(aiUsage)
      .values({
        workspaceId: meta.workspaceId,
        listingId: meta.listingId ?? null,
        model,
        status: "error",
        error: e instanceof Error ? e.message.slice(0, 500) : String(e),
      })
      .catch(() => {});
    throw e;
  }
}
