import { createBrowserRouter, Navigate } from "react-router";
import { Shell } from "./shell/Shell";
import { JobsPage } from "./pages/Jobs";
import { ListingEditPage } from "./pages/ListingEdit";
import { LoginPage, RegisterPage } from "./pages/Auth";
import { ProductsPage } from "./pages/Products";
import { SelectionPage } from "./pages/Selection";
import { SettingsPage } from "./pages/Settings";
import { StoresPage } from "./pages/Stores";
import { WorkbenchPage } from "./pages/Workbench";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <WorkbenchPage /> },
      { path: "selection", element: <SelectionPage /> },
      { path: "products", element: <ProductsPage /> },
      { path: "stores", element: <StoresPage /> },
      { path: "jobs", element: <JobsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "listings/:id", element: <ListingEditPage /> },
      // 旧路由兼容重定向（不显示在一级导航）
      { path: "collect-box", element: <Navigate to="/" replace /> },
      { path: "listings", element: <Navigate to="/products" replace /> },
      { path: "category-mappings", element: <Navigate to="/settings" replace /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
