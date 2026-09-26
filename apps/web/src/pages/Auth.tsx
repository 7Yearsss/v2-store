import { useQueryClient } from "@tanstack/react-query";
import { Button, Card, Form, Input, Typography } from "antd";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <Card style={{ width: 380 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {title}
        </Typography.Title>
        {children}
      </Card>
    </div>
  );
}

function useAfterAuth() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  return async () => {
    await qc.invalidateQueries();
    const next = params.get("next");
    navigate(next?.startsWith("/") ? next : "/", { replace: true });
  };
}

export function LoginPage() {
  const done = useAfterAuth();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  return (
    <AuthShell title="登录">
      <Form
        layout="vertical"
        onFinish={async (v) => {
          setLoading(true);
          setError(undefined);
          try {
            await api.login(v);
            await done();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setLoading(false);
          }
        }}
      >
        <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}>
          <Input autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        {error && <Typography.Text type="danger">{error}</Typography.Text>}
        <Button type="primary" htmlType="submit" block loading={loading} style={{ marginTop: 8 }}>
          登录
        </Button>
      </Form>
      <div style={{ marginTop: 16 }}>
        还没有账号？<Link to="/register">注册</Link>
      </div>
    </AuthShell>
  );
}

export function RegisterPage() {
  const done = useAfterAuth();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  return (
    <AuthShell title="注册">
      <Form
        layout="vertical"
        onFinish={async (v) => {
          setLoading(true);
          setError(undefined);
          try {
            await api.register(v);
            await done();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setLoading(false);
          }
        }}
      >
        <Form.Item name="name" label="你的名字" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="workspaceName" label="团队名称（可选）">
          <Input />
        </Form.Item>
        <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}>
          <Input autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, min: 8, message: "至少 8 位" }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {error && <Typography.Text type="danger">{error}</Typography.Text>}
        <Button type="primary" htmlType="submit" block loading={loading} style={{ marginTop: 8 }}>
          注册并登录
        </Button>
      </Form>
      <div style={{ marginTop: 16 }}>
        已有账号？<Link to="/login">登录</Link>
      </div>
    </AuthShell>
  );
}
