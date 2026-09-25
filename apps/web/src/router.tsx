import { createBrowserRouter, Navigate } from "react-router";
import { AppLayout } from "./layout/AppLayout";
import { CategoryMappingsPage } from "./pages/CategoryMappings";
import { CollectBoxPage } from "./pages/CollectBox";
import { ListingEditPage } from "./pages/ListingEdit";
import { ListingsPage } from "./pages/Listings";
import { LoginPage, RegisterPage } from "./pages/Auth";
import { StoresPage } from "./pages/Stores";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/collect-box" replace /> },
      { path: "collect-box", element: <CollectBoxPage /> },
      { path: "listings", element: <ListingsPage /> },
      { path: "listings/:id", element: <ListingEditPage /> },
      { path: "stores", element: <StoresPage /> },
      { path: "category-mappings", element: <CategoryMappingsPage /> },
    ],
  },
]);
