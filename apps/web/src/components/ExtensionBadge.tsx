import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { App } from "antd";
import { api } from "../api";
import { authorizeExtension, pingExtension } from "../extensionBridge";

export function useExtension() {
  return useQuery({
    queryKey: ["extension"],
    queryFn: () => pingExtension(),
    staleTime: 30_000,
    retry: false,
  });
}

/** 顶栏插件状态：未装/未授权/已连接，授权动作在这里完成。 */
export function ExtensionBadge() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const ext = useExtension();
  const [busy, setBusy] = useState(false);
  if (ext.isLoading) return null;
  if (!ext.data) {
    return (
      <span className="tag" title="安装 V2Store 采集插件后刷新页面">
        插件未安装
      </span>
    );
  }
  const authorize = async () => {
    setBusy(true);
    try {
      const { token } = await api.extensionToken();
      await authorizeExtension(window.location.origin, token);
      await ext.refetch();
      message.success("插件已授权到当前团队");
      qc.invalidateQueries();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return ext.data.authorized ? (
    <span className="st" data-tone="success" title="点击重新授权">
      <span className="st-dot" data-st="success" />
      <button type="button" className="btn ghost sm" onClick={authorize} disabled={busy} style={{ height: 22 }}>
        插件已连接
      </button>
    </span>
  ) : (
    <button type="button" className="btn sm primary" onClick={authorize} disabled={busy}>
      授权插件
    </button>
  );
}
