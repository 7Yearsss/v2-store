import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Shop } from "@studio/shared";
import { api } from "../api.js";

export interface ShopScopeValue {
  /** 当前店铺范围；null = 全部店铺 */
  shopId: string | null;
  setShopId: (id: string | null) => void;
  shops: Shop[];
  loading: boolean;
}

const ShopScopeContext = createContext<ShopScopeValue | null>(null);

export function useShopScope(): ShopScopeValue {
  const v = useContext(ShopScopeContext);
  if (!v) throw new Error("useShopScope must be used within <Shell>");
  return v;
}

export function ShopScopeProvider({ children }: { children: ReactNode }) {
  const [shopId, setShopId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["shops"],
    queryFn: () => api.shops(),
  });
  const shops = useMemo(() => data?.items ?? [], [data]);

  const value = useMemo<ShopScopeValue>(() => {
    // 选中的店被删了则回落到「全部店铺」
    const effective = shopId && shops.some((s) => s.id === shopId) ? shopId : null;
    return { shopId: effective, setShopId, shops, loading: isLoading };
  }, [shopId, shops, isLoading]);

  return <ShopScopeContext.Provider value={value}>{children}</ShopScopeContext.Provider>;
}
