import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import type { Store } from "@caiji/shared";

export interface StoreScopeValue {
  stores: Store[];
  /** null = 全部店铺 */
  storeId: string | null;
  setStoreId: (id: string | null) => void;
  store: Store | null;
  /** 状态异常（error/disconnected）的店铺数，顶栏徽标用 */
  errorCount: number;
}

const Ctx = createContext<StoreScopeValue | null>(null);

export function StoreScopeProvider({ children }: { children: ReactNode }) {
  const [storeId, setStoreId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["stores"], queryFn: api.stores });
  const value = useMemo<StoreScopeValue>(() => {
    const stores = q.data ?? [];
    const store = stores.find((s) => s.id === storeId) ?? null;
    return {
      stores,
      storeId: store ? storeId : null,
      setStoreId,
      store,
      errorCount: stores.filter((s) => s.status !== "active").length,
    };
  }, [q.data, storeId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStoreScope(): StoreScopeValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStoreScope must be used inside StoreScopeProvider");
  return v;
}
