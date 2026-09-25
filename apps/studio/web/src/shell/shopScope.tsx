import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Shop } from "@studio/shared";
import { api } from "../api.js";

/** 顶栏店铺范围：null = 全部店铺。挂在壳上，切页不丢。 */
export interface ShopScopeValue {
  /** 当前范围店铺 id；null 表示「全部店铺」 */
  shopId: string | null;
  setShopId: (id: string | null) => void;
  /** 全量店铺（页面做对照/过滤时直接用，不必再发请求） */
  shops: Shop[];
  /** 当前范围店铺对象；null = 全部店铺 */
  shop: Shop | null;
  /** authStatus==="expired" 的店铺数——状态栏/导航徽标共用 */
  expiredCount: number;
}

const ShopScopeCtx = createContext<ShopScopeValue | null>(null);

export function ShopScopeProvider({ children }: { children: ReactNode }) {
  const [shopId, setShopId] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["shops"],
    queryFn: () => api.shops(),
    refetchInterval: 30_000,
  });
  const shops = useMemo(() => data?.items ?? [], [data]);
  const shop = shops.find((s) => s.id === shopId) ?? null;

  // 选中的店被删后回落到「全部店铺」
  useEffect(() => {
    if (shopId && data && !shop) setShopId(null);
  }, [shopId, data, shop]);

  const value = useMemo<ShopScopeValue>(
    () => ({
      shopId: shop ? shopId : null,
      setShopId,
      shops,
      shop,
      expiredCount: shops.filter((s) => s.authStatus === "expired").length,
    }),
    [shopId, shops, shop],
  );
  return <ShopScopeCtx.Provider value={value}>{children}</ShopScopeCtx.Provider>;
}

export function useShopScope(): ShopScopeValue {
  const v = useContext(ShopScopeCtx);
  if (!v) throw new Error("useShopScope 必须在 ShopScopeProvider 内使用");
  return v;
}
