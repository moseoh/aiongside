import { useEffect } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { Layout } from "@/components/Layout";
import { useSettings } from "@/lib/settings";
import { KnowledgePage } from "@/pages/Knowledge";
import { WorkDetailPage } from "@/pages/WorkDetail";
import { WorkListPage } from "@/pages/WorkList";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Navigate to="/work" replace /> },
      { path: "/work", element: <WorkListPage /> },
      { path: "/work/:id", element: <WorkDetailPage /> },
      { path: "/work/:id/file/*", element: <WorkDetailPage /> },
      { path: "/knowledge", element: <KnowledgePage /> },
      { path: "/knowledge/*", element: <KnowledgePage /> },
      { path: "*", element: <Navigate to="/work" replace /> },
    ],
  },
]);

export function App() {
  const { theme, lang } = useSettings();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    document.documentElement.lang = lang;
  }, [theme, lang]);
  return <RouterProvider router={router} />;
}
