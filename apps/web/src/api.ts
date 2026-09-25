import type {
  Listing,
  ListingStatus,
  Me,
  Page,
  PricingRule,
  SourceItem,
  Store,
} from "@caiji/shared";

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

export const api = {
  me: () => request<Me>("GET", "/auth/me"),
  login: (body: { email: string; password: string }) => request("POST", "/auth/login", body),
  register: (body: { email: string; password: string; name: string; workspaceName?: string }) =>
    request("POST", "/auth/register", body),
  logout: () => request("POST", "/auth/logout", {}),
  extensionToken: () =>
    request<{ token: string; expiresAt: string }>("POST", "/auth/extension-token", {}),

  sourceItems: (p: { q?: string; page?: number; pageSize?: number }) =>
    request<Page<SourceItem>>("GET", `/source-items${qs(p)}`),
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
  updateStore: (id: string, body: { name?: string; pricing?: PricingRule }) =>
    request<Store>("PATCH", `/stores/${id}`, body),
  verifyStore: (id: string) => request<Store>("POST", `/stores/${id}/verify`, {}),
  deleteStore: (id: string) => request("DELETE", `/stores/${id}`),

  listings: (p: { status?: ListingStatus; storeId?: string; q?: string; page?: number; pageSize?: number }) =>
    request<Page<Listing>>("GET", `/listings${qs(p)}`),
  listingCounts: () => request<Partial<Record<ListingStatus, number>>>("GET", "/listings/counts"),
  listing: (id: string) => request<Listing>("GET", `/listings/${id}`),
  updateListing: (id: string, body: Partial<Listing>) => request<Listing>("PATCH", `/listings/${id}`, body),
  publish: (ids: string[]) => request<{ queued: number; skipped: number }>("POST", "/listings/publish", { ids }),
  deleteListings: (ids: string[]) => request<{ deleted: number }>("POST", "/listings/delete", { ids }),
};
