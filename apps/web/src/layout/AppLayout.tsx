import {
  ApartmentOutlined,
  DashboardOutlined,
  InboxOutlined,
  LogoutOutlined,
  ShopOutlined,
  SyncOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Dropdown, Layout, Menu, Space, Spin, Tag, Tooltip } from "antd";
import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { authorizeExtension, pingExtension } from "../extensionBridge";

const MENU = [
  { key: "/", icon: <DashboardOutlined />, label: "工作台" },
  { key: "/collect-box", icon: <InboxOutlined />, label: "采集箱" },
  { key: "/listings", icon: <UnorderedListOutlined />, label: "刊登管理" },
  { key: "/stores", icon: <ShopOutlined />, label: "店铺授权" },
  { key: "/category-mappings", icon: <ApartmentOutlined />, label: "映射管理" },
  { key: "/jobs", icon: <SyncOutlined />, label: "任务中心" },
];

export function useExtension() {
  return useQuery({
    queryKey: ["extension"],
    queryFn: () => pingExtension(),
    staleTime: 30_000,
  });
}

function ExtensionBadge() {
  const { message } = App.useApp();
  const ext = useExtension();
  const [busy, setBusy] = useState(false);
  if (ext.isLoading) return null;
  if (!ext.data) {
    return (
      <Tooltip title="安装 V2Store 采集插件后刷新页面">
        <Tag color="default">插件未安装</Tag>
      </Tooltip>
    );
  }
  const authorize = async () => {
    setBusy(true);
    try {
      const { token } = await api.extensionToken();
      await authorizeExtension(window.location.origin, token);
      await ext.refetch();
      message.success("插件已授权到当前团队");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return ext.data.authorized ? (
    <Space size={4}>
      <Tag color="green">插件已连接 v{ext.data.version}</Tag>
      <Button size="small" type="link" loading={busy} onClick={authorize}>
        重新授权
      </Button>
    </Space>
  ) : (
    <Button size="small" type="primary" loading={busy} onClick={authorize}>
      授权插件
    </Button>
  );
}

export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  if (me.isLoading || !me.data) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Spin />
      </div>
    );
  }

  const selected =
    pathname === "/" ? "/" : (MENU.find((m) => m.key !== "/" && pathname.startsWith(m.key))?.key ?? "/collect-box");

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider theme="light" width={200} breakpoint="lg" collapsedWidth={0}>
        <div style={{ padding: "18px 24px", fontWeight: 700, fontSize: 18, color: "#f97316" }}>
          V2Store
        </div>
        <Menu mode="inline" selectedKeys={[selected]} items={MENU} onClick={(e) => navigate(e.key)} />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            background: "#fff",
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 16,
            borderBottom: "1px solid #f0f0f0",
          }}
        >
          <ExtensionBadge />
          <Dropdown
            menu={{
              items: [
                {
                  key: "logout",
                  icon: <LogoutOutlined />,
                  label: "退出登录",
                  onClick: async () => {
                    await api.logout();
                    qc.clear();
                    navigate("/login");
                  },
                },
              ],
            }}
          >
            <span style={{ cursor: "pointer" }}>
              {me.data.user.name} · {me.data.workspace.name}
            </span>
          </Dropdown>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
