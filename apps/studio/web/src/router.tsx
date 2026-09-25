import { createBrowserRouter, Navigate } from "react-router";
import { Shell } from "./shell/Shell.js";
import { PublishPage } from "./pages/PublishPage.js";
import { ProductsPage } from "./pages/ProductsPage.js";
import { ShopsPage } from "./pages/ShopsPage.js";
import { TasksPage } from "./pages/TasksPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { DemoContent } from "./shell/DemoContent.js";

/** 冻结 IA：一级导航只有这 5 个，默认落在「铺货」。 */
export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Navigate to="/publish" replace /> },
      { path: "/publish", element: <PublishPage /> },       // 铺货（三栏主界面）
      { path: "/products", element: <ProductsPage /> },    // 商品
      { path: "/shops", element: <ShopsPage /> },          // 店铺
      { path: "/tasks", element: <TasksPage /> },          // 任务
      { path: "/tasks/:id", element: <TasksPage /> },
      { path: "/settings", element: <SettingsPage /> },    // 设置
      { path: "/__demo", element: <DemoContent /> },       // 壳层竞赛演示（集成时人工裁决）
      { path: "*", element: <Navigate to="/publish" replace /> },
    ],
  },
]);
