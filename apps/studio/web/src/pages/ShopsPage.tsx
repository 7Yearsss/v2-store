import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Store } from "lucide-react";
import { useState } from "react";
import type { PlatformId, Shop } from "@studio/shared";
import { api } from "../api.js";
import {
  Empty,
  Err,
  Loading,
  Modal,
  PLATFORM_NAME,
  PlatformBadge,
  St,
} from "../components/ui.js";

/** /shops —— 店铺授权与站点 */
export function ShopsPage() {
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);

  const shopsQ = useQuery({ queryKey: ["shops"], queryFn: () => api.shops() });
  const items = shopsQ.data?.items ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["shops"] });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeShop(id), onSuccess: invalidate });
  const reauth = useMutation({ mutationFn: (id: string) => api.reauthShop(id), onSuccess: invalidate });
  const del = useMutation({ mutationFn: (id: string) => api.deleteShop(id), onSuccess: invalidate });

  return (
    <div className="pg">
      <div className="pg-head">
        <span className="pg-sub">{items.length} 间店铺 · 授权过期会挡发布</span>
        <span className="pg-spacer" />
        <button type="button" className="btn primary" onClick={() => setConnecting(true)}>
          <Plus size={14} /> 连接店铺
        </button>
      </div>

      {shopsQ.isPending ? (
        <Loading />
      ) : shopsQ.isError ? (
        <Err error={shopsQ.error} onRetry={() => shopsQ.refetch()} />
      ) : items.length === 0 ? (
        <Empty icon={<Store size={20} />}>
          还没有店铺。连接一间 Shopee 或 TikTok 店，才能铺货。
        </Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>平台</th>
                <th>店名</th>
                <th>站点</th>
                <th>授权</th>
                <th>外部 ID</th>
                <th className="t-act">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <ShopRow
                  key={s.id}
                  s={s}
                  busy={revoke.isPending || reauth.isPending || del.isPending}
                  onRevoke={() => revoke.mutate(s.id)}
                  onReauth={() => reauth.mutate(s.id)}
                  onDelete={() => {
                    if (window.confirm(`删除店铺「${s.name}」？历史任务记录保留。`)) {
                      del.mutate(s.id);
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {connecting && (
        <ConnectShopModal
          onClose={() => setConnecting(false)}
          onCreated={invalidate}
        />
      )}
    </div>
  );
}

function ShopRow({
  s,
  busy,
  onRevoke,
  onReauth,
  onDelete,
}: {
  s: Shop;
  busy: boolean;
  onRevoke: () => void;
  onReauth: () => void;
  onDelete: () => void;
}) {
  const expired = s.authStatus === "expired";
  return (
    <tr>
      <td>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <PlatformBadge id={s.platform} />
          {PLATFORM_NAME[s.platform]}
        </span>
      </td>
      <td style={{ fontWeight: 500 }}>{s.name}</td>
      <td>
        <span className="tag">{s.site}</span>
      </td>
      <td>
        <St st={expired ? "failed" : "success"}>{expired ? "已过期" : "已授权"}</St>
      </td>
      <td style={{ color: "var(--text-tertiary)" }}>{s.externalId ?? "—"}</td>
      <td className="t-act">
        {expired ? (
          <button type="button" className="btn ghost sm" disabled={busy} onClick={onReauth}>
            重新授权
          </button>
        ) : (
          <button type="button" className="btn ghost sm" disabled={busy} onClick={onRevoke}>
            吊销授权
          </button>
        )}
        <button type="button" className="btn ghost sm danger" disabled={busy} onClick={onDelete}>
          删除
        </button>
      </td>
    </tr>
  );
}

function ConnectShopModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const platformsQ = useQuery({ queryKey: ["platforms"], queryFn: () => api.platforms() });
  const platforms = platformsQ.data?.items ?? [];

  const [platform, setPlatform] = useState<PlatformId | "">("");
  const [site, setSite] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const meta = platforms.find((p) => p.id === platform);
  const sites = meta?.sites ?? [];

  const submit = async () => {
    if (busy || !platform || !site || !name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createShop({ platform, site, name: name.trim() });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="连接店铺"
      onClose={onClose}
      footer={
        <>
          <span className="mo-note" style={{ marginRight: "auto" }}>
            演示环境：保存即完成授权，不走真实 OAuth
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !platform || !site || !name.trim()}
            onClick={submit}
          >
            {busy ? "连接中…" : "授权并连接"}
          </button>
        </>
      }
    >
      {platformsQ.isPending ? (
        <Loading />
      ) : (
        <>
          <div className="grid2">
            <div className="fld">
              <div className="fld-label">平台</div>
              <select
                className="inp"
                value={platform}
                onChange={(e) => {
                  setPlatform(e.target.value as PlatformId);
                  setSite("");
                }}
              >
                <option value="">选择平台</option>
                {platforms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <div className="fld-label">站点</div>
              <select
                className="inp"
                value={site}
                onChange={(e) => setSite(e.target.value)}
                disabled={!platform}
              >
                <option value="">{platform ? "选择站点" : "先选平台"}</option>
                {sites.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="fld">
            <div className="fld-label">店名</div>
            <input
              className="inp"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：马来旗舰店"
            />
          </div>
          {err != null && <Err error={err} />}
        </>
      )}
    </Modal>
  );
}
