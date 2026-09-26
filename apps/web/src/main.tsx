import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router";
import "./theme.css";
import "./wb.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#5e6ad2",
          colorBgBase: "#0b0c0e",
          colorBgContainer: "#131417",
          colorBgElevated: "#1a1c20",
          colorBorder: "#26282e",
          colorBorderSecondary: "#1e2025",
          colorTextBase: "#e7e8ea",
          colorTextSecondary: "#9ca0a8",
          borderRadius: 6,
          fontSize: 13,
        },
      }}
    >
      <App>
        <RouterProvider router={router} />
        </App>
      </ConfigProvider>
    </QueryClientProvider>
  </StrictMode>,
);
