import type {
  AiField,
  AiMode,
  AuditLog,
  ChannelCheck,
  ListingDraft,
  Page,
  PlatformId,
  PlatformMeta,
  Product,
  PublishJobDetail,
  Shop,
} from "@studio/shared";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `请求失败 ${r.status}`);
  }
  if (r.status === 204) return undefined as T;
  return r.json();
}

export const api = {
  shops: () => req<Page<Shop>>("/shops"),
  createShop: (input: { platform: PlatformId; site: string; name: string; externalId?: string }) =>
    req<Shop>("/shops", { method: "POST", body: JSON.stringify(input) }),
  revokeShop: (id: string) => req<Shop>(`/shops/${id}/revoke`, { method: "POST" }),
  reauthShop: (id: string) => req<Shop>(`/shops/${id}/reauth`, { method: "POST" }),
  deleteShop: (id: string) => req<void>(`/shops/${id}`, { method: "DELETE" }),

  products: (q?: string) => req<Page<Product>>(`/products${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createProduct: (input: {
    title: string;
    images?: string[];
    variants?: Product["variants"];
    sourceCategory?: string | null;
  }) => req<Product>("/products", { method: "POST", body: JSON.stringify(input) }),
  importCsv: (csv: string) =>
    req<{ created: Product[]; errors: { row: number; message: string }[] }>(
      "/products/import",
      { method: "POST", body: JSON.stringify({ csv }) },
    ),
  productFromUrl: (url: string) =>
    req<Product>("/products/from-url", { method: "POST", body: JSON.stringify({ url }) }),
  deleteProduct: (id: string) => req<void>(`/products/${id}`, { method: "DELETE" }),

  draft: (productId: string) => req<ListingDraft>(`/products/${productId}/draft`),
  patchDraft: (productId: string, patch: Partial<ListingDraft["fields"]>) =>
    req<ListingDraft>(`/products/${productId}/draft`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  runAi: (productId: string, input: { field: AiField; mode: AiMode; channel?: PlatformId }) =>
    req<ListingDraft>(`/products/${productId}/draft/ai`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  preview: (productId: string, shopIds: string[]) =>
    req<{ checks: ChannelCheck[] }>("/publish/preview", {
      method: "POST",
      body: JSON.stringify({ productId, shopIds }),
    }),
  publish: (productId: string, shopIds: string[]) =>
    req<PublishJobDetail>("/publish/jobs", {
      method: "POST",
      body: JSON.stringify({ productId, shopIds }),
    }),
  jobs: (page = 1) => req<Page<PublishJobDetail>>(`/publish/jobs?page=${page}`),
  job: (id: string) => req<PublishJobDetail>(`/publish/jobs/${id}`),
  retryAttempt: (id: string) =>
    req<PublishJobDetail>(`/publish/attempts/${id}/retry`, { method: "POST" }),

  platforms: () => req<{ items: PlatformMeta[] }>("/meta/platforms"),
  auditLogs: (entityType?: string, entityId?: string) =>
    req<Page<AuditLog>>(
      `/meta/audit-logs${entityType ? `?entityType=${entityType}&entityId=${entityId ?? ""}` : ""}`,
    ),
};
