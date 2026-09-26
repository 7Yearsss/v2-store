import type {
  AttributeMapping,
  ChannelAttribute,
  CategoryCandidate,
  CategoryMapping,
  Job,
  JobStatus,
  Listing,
  ListingStatus,
  ListingSuggestion,
  ListingTemplate,
  Me,
  Page,
  PricingRule,
  RemoteStatus,
  SourceItem,
  Store,
  StoreRules,
  TermMapping,
  StoreSettingsPayload,
} from "@caiji/shared";

export interface Overview {
  collectBox: { total: number; unclaimed: number };
  listings: Record<ListingStatus, number>;
  jobs: { pending: number; running: number; failed24h: number };
  /** 最近 24h AI 调用用量 */
  ai24h: { calls: number; tokens: number; errors: number };
  recentResults: Array<{
    id: string;
    title: string;
    status: ListingStatus;
    remoteStatus: RemoteStatus | null;
    lastError: string | null;
    updatedAt: string;
  }>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // zod-validator errors come back as { success:false, error:{...} }
    const message =
      data?.error && typeof data.error === "string"
        ? data.error
        : data?.error?.issues?.[0]?.message ?? `请求失败 (${res.status})`;
    throw new ApiError(res.status, message, data?.code);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
  ).toString();
  return s ? `?${s}` : "";
};

export interface PublishPreview {
  ok: boolean;
  warnings: string[];
  product: {
    title: string;
    vendor: string;
    productType: string;
    tags: string[];
    status: string;
    seo: { title: string; description: string };
    categoryId: string;
    categoryName: string;
    imageCount: number;
    options: { name: string; values: string[] }[];
    variants: { sku: string; price: string; compareAtPrice: string; cost: string; optionValues: string[] }[];
    trackStock: boolean;
    attributes: { name: string; value: string }[];
  } | null;
}

export const api = {
  /** 未纳入 api 的端点直取（如尚未合并的 publish-runs）。 */
  raw: <T>(path: string) => request<T>("GET", path),

  me: () => request<Me>("GET", "/auth/me"),
  login: (body: { email: string; password: string }) => request("POST", "/auth/login", body),
  register: (body: { email: string; password: string; name: string; workspaceName?: string }) =>
    request("POST", "/auth/register", body),
  logout: () => request("POST", "/auth/logout", {}),
  extensionToken: () =>
    request<{ token: string; expiresAt: string }>("POST", "/auth/extension-token", {}),

  sourceItems: (p: { q?: string; unclaimed?: boolean; page?: number; pageSize?: number }) =>
    request<Page<SourceItem>>("GET", `/source-items${qs({ ...p, unclaimed: p.unclaimed ? 1 : undefined })}`),
  deleteSourceItems: (ids: string[]) => request<{ deleted: number }>("POST", "/source-items/delete", { ids }),
  claim: (ids: string[], storeIds: string[]) =>
    request<{ created: number; skipped: number }>("POST", "/source-items/claim", { ids, storeIds }),

  stores: () => request<Store[]>("GET", "/stores"),
  connectShopify: (
    body:
      | { authType: "access_token"; shopDomain: string; accessToken: string }
      | { authType: "client_credentials"; shopDomain: string; clientId: string; clientSecret: string },
  ) => request<Store>("POST", "/stores/shopify", body),
  shopifyInstallUrl: (shop: string) =>
    request<{ url: string }>("GET", `/shopify/install${qs({ shop })}`),
  updateStore: (
    id: string,
    body: {
      name?: string;
      pricing?: PricingRule;
      vendor?: string;
      aiEnhance?: boolean;
      language?: string;
      rules?: StoreRules;
    },
  ) => request<Store>("PATCH", `/stores/${id}`, body),
  verifyStore: (id: string) => request<Store>("POST", `/stores/${id}/verify`, {}),
  deleteStore: (id: string) => request("DELETE", `/stores/${id}`),
  syncStore: (id: string) => request<{ queued: boolean }>("POST", `/stores/${id}/sync`, {}),
  syncStoreCategories: (id: string) =>
    request<{ queued: boolean }>("POST", `/stores/${id}/sync-categories`, {}),
  storeLocations: (id: string) =>
    request<{ items: Array<{ id: string; name: string; isActive: boolean }> }>(
      "GET",
      `/stores/${id}/locations`,
    ),
  storeCategories: (storeId: string, q: string) =>
    request<{ items: CategoryCandidate[] }>("GET", `/stores/${storeId}/categories${qs({ q })}`),

  listings: (p: { status?: ListingStatus; storeId?: string; q?: string; page?: number; pageSize?: number }) =>
    request<Page<Listing>>("GET", `/listings${qs(p)}`),
  overview: () => request<Overview>("GET", "/overview"),
  jobs: (p: { status?: JobStatus; page?: number; pageSize?: number }) =>
    request<Page<Job>>("GET", `/jobs${qs(p)}`),
  retryJob: (id: string) => request<Job>("POST", `/jobs/${id}/retry`),
  listingCounts: () => request<Partial<Record<ListingStatus, number>>>("GET", "/listings/counts"),
  listing: (id: string) => request<Listing>("GET", `/listings/${id}`),
  updateListing: (id: string, body: Partial<Listing>) => request<Listing>("PATCH", `/listings/${id}`, body),
  publish: (ids: string[]) =>
    request<{ queued: number; skipped: number; blocked: Array<{ id: string; title: string; words: string[] }> }>(
      "POST",
      "/listings/publish",
      { ids },
    ),
  deleteListings: (ids: string[]) => request<{ deleted: number }>("POST", "/listings/delete", { ids }),
  delist: (ids: string[]) =>
    request<{ queued: number; skipped: number }>("POST", "/listings/delist", { ids }),
  copyListing: (id: string, storeId: string) =>
    request<Listing>("POST", `/listings/${id}/copy`, { storeId }),
  publishPreview: (id: string) => request<PublishPreview>("GET", `/listings/${id}/publish-preview`),
  listingSuggestions: (id: string) =>
    request<{ items: ListingSuggestion[]; pending: boolean }>(
      "GET",
      `/listings/${id}/suggestions`,
    ),
  decideSuggestions: (
    id: string,
    decisions: Array<{ id: string; action: "accept" | "reject"; choice?: string }>,
  ) =>
    request<{ accepted: number; rejected: number }>(
      "POST",
      `/listings/${id}/suggestions/decide`,
      { decisions },
    ),
  aiEnhance: (id: string) => request<{ queued: boolean }>("POST", `/listings/${id}/ai-enhance`, {}),
  setListingCategory: (
    id: string,
    body: { channelCategoryId: string; channelCategoryName: string; remember?: boolean },
  ) => request<Listing>("POST", `/listings/${id}/category`, body),

  categoryMappings: () => request<{ items: CategoryMapping[] }>("GET", "/category-mappings"),
  deleteCategoryMapping: (id: string) => request<{ ok: boolean }>("DELETE", `/category-mappings/${id}`),

  termMappings: () => request<{ items: TermMapping[] }>("GET", "/term-mappings"),
  upsertTermMapping: (body: { lang: string; sourceText: string; targetText: string }) =>
    request<{ item: TermMapping }>("PUT", "/term-mappings", body),
  deleteTermMapping: (id: string) => request<{ ok: boolean }>("DELETE", `/term-mappings/${id}`),

  templates: () => request<{ items: ListingTemplate[] }>("GET", "/templates"),
  saveTemplate: (body: { name: string; payload: StoreSettingsPayload }) =>
    request<{ item: ListingTemplate }>("POST", "/templates", body),
  deleteTemplate: (id: string) => request<{ ok: boolean }>("DELETE", `/templates/${id}`),

  categoryAttributes: (storeId: string, categoryId: string) =>
    request<{ items: ChannelAttribute[] }>(
      "GET",
      `/stores/${storeId}/categories/${encodeURIComponent(categoryId)}/attributes`,
    ),
  attributeMappings: (channel?: string) =>
    request<{ items: AttributeMapping[] }>(
      "GET",
      `/attribute-mappings${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`,
    ),
  upsertAttributeMapping: (body: {
    channel: string;
    sourceName: string;
    channelAttrId: string;
    channelAttrName: string;
  }) => request<AttributeMapping>("PUT", "/attribute-mappings", body),
  deleteAttributeMapping: (id: string) =>
    request<{ ok: boolean }>("DELETE", `/attribute-mappings/${id}`),
};
