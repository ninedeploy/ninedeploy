import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router";

import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Features } from "./pages/Features";
import { DocsLayout, docPages, DocPage } from "./pages/Docs";
import { Faq } from "./pages/Faq";
import { Templates } from "./pages/Templates";
import { NotFound } from "./pages/NotFound";

// The changelog page bundles the whole CHANGELOG.md — load it only on visit.
const Changelog = lazy(() => import("./pages/Changelog").then((m) => ({ default: m.Changelog })));

const titles: Record<string, string> = {
  "/": "NineDeploy — ship like you mean it",
  "/features": "Features — NineDeploy",
  "/templates": "Templates — NineDeploy",
  "/changelog": "Changelog — NineDeploy",
  "/faq": "FAQ — NineDeploy",
};

function usePageTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const doc = docPages.find((d) => pathname === `/docs/${d.slug}`);
    document.title = doc
      ? `${doc.title} — NineDeploy docs`
      : (titles[pathname] ?? "Not found — NineDeploy");
  }, [pathname]);
}

function ScrollToTop() {
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every route change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("nd-site-theme", theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  usePageTitle();

  return (
    <Layout theme={theme} onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}>
      <ScrollToTop />
      <PageFade>
        <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/features" element={<Features />} />
        <Route path="/templates" element={<Templates />} />
        <Route
          path="/changelog"
          element={
            <Suspense fallback={<div className="min-h-screen" />}>
              <Changelog />
            </Suspense>
          }
        />
        <Route path="/faq" element={<Faq />} />
        <Route path="/docs" element={<DocsLayout />}>
          <Route index element={<Navigate to="/docs/introduction" replace />} />
          {docPages.map((d) => (
            <Route key={d.slug} path={d.slug} element={<DocPage doc={d} />} />
          ))}
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      </PageFade>
    </Layout>
  );
}

/** Fades each route in — keyed by pathname so every navigation restarts it.
 * Opacity-only (never transform) so `fixed`/`sticky` descendants keep their
 * positioning context. */
function PageFade({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div key={pathname} className="page-fade">
      {children}
    </div>
  );
}
