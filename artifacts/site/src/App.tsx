import { useEffect, useState } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CartProvider } from "@/lib/cart";
import { UtmProvider } from "@/lib/utm";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Shop from "@/pages/shop";
import Product from "@/pages/product";
import Cart from "@/pages/cart";
import Checkout from "@/pages/checkout";
import Order from "@/pages/order";
import Account from "@/pages/account";
import BlogProgress from "@/pages/blog-progress";
import RedeemPages from "@/pages/redeem-pages";
import Faq from "@/pages/faq";
import Mailbox from "@/pages/mailbox";
const queryClient = new QueryClient();

import React from 'react';
import { StatusBanner } from "@/components/status-banner";
import { AuthProvider, useAuth } from "@/lib/auth";
import { CookieBanner } from "@/components/cookie-banner";
import { setBaseUrl } from "@workspace/api-client-react";

const apiBaseUrl = import.meta.env.VITE_API_URL;
if (apiBaseUrl) {
  setBaseUrl(apiBaseUrl);
}

function Router() {
  const HomeRoute = () => {
    if (window.location.hostname === "authn.afeonbooks.com") return <Account />;
    if (window.location.hostname === "mailsystem.afeonbooks.com") return <Mailbox />;
    const params = new URLSearchParams(window.location.search);
    return params.has("reset_token") || params.has("verify_token") ? <Account /> : <Home />;
  };
  return (
    <Switch>
      <Route path="/" component={HomeRoute} />
      <Route path="/shop" component={Shop} />
      <Route path="/product/:id" component={Product} />
      <Route path="/cart" component={Cart} />
      <Route path="/checkout" component={Checkout} />
      <Route path="/orders/:id" component={Order} />
      {/* Keep existing singular links working while plural is canonical. */}
      <Route path="/order/:id" component={Order} />
      <Route path="/sign-in/:token" component={Account} />
      <Route path="/account-check/:token" component={Account} />
      <Route path="/account" component={Account} />
      <Route path="/blog" component={BlogProgress} />
      <Route path="/faq" component={Faq} />
      <Route path="/redeem-pages" component={RedeemPages} />
      <Route component={NotFound} />
    </Switch>
  );
}

function MailSystemAccessGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<"loading" | "signed-out" | "account-required" | "github-required" | "allowed">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setStatus("signed-out");
      return;
    }
    if (user.role !== "staff" && user.role !== "admin") {
      setStatus("account-required");
      return;
    }
    let cancelled = false;
    fetch("/api/auth/admin/access", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { user?: { role?: string }; error?: string };
        if (response.status === 403) {
          if (!cancelled) setError(data.error ?? "");
          if (!cancelled) setStatus("github-required");
          return;
        }
        if (!response.ok) throw new Error(data.error ?? "Unable to verify mailbox access");
        if (!cancelled) setStatus(data.user?.role === "staff" || data.user?.role === "admin" ? "allowed" : "account-required");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Unable to verify mailbox access");
        setStatus("github-required");
      });
    return () => { cancelled = true; };
  }, [loading, user]);

  if (status === "allowed") return <>{children}</>;
  if (status === "loading" || loading) return <main className="flex min-h-screen items-center justify-center">Checking mailbox access…</main>;
  const signInUrl = new URL("https://afeonbooks.com/api/auth/github/start");
  signInUrl.searchParams.set("return_to", window.location.href);
  return (
    <main className="flex min-h-screen items-center justify-center px-6 text-center">
      <div className="max-w-md">
        <h1 className="text-xl font-semibold">Staff mailbox access required</h1>
        <p className="mt-2 text-sm text-black/60">{status === "github-required" ? error || "Use the GitHub username linked to an AFEON Books staff or admin account." : status === "account-required" ? "Sign in with a GitHub account linked to an AFEON Books account that has the staff or admin role." : "Continue with the GitHub username linked to your AFEON Books staff or admin account."}</p>
        {(status === "signed-out" || status === "github-required") && <a className="mt-5 inline-block border border-black/20 px-5 py-3 text-xs font-bold uppercase tracking-widest" href={signInUrl.toString()}>{status === "signed-out" ? "Sign in with GitHub" : "Continue with GitHub"}</a>}
      </div>
    </main>
  );
}

function useImageProtection() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".allow-select")) return;
      if (target.tagName === "IMG" || target.closest("img")) {
        e.preventDefault();
      }
    };
    const onDragStart = (e: DragEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".allow-select")) return;
      if (target.tagName === "IMG") {
        e.preventDefault();
      }
    };
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("dragstart", onDragStart);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("dragstart", onDragStart);
    };
  }, []);
}

function useDevAudit() {
  useEffect(() => {
    if (import.meta.env.PROD) return;
    const storageKey = "afeonbooks_dev_visitor_id";
    const visitorId = localStorage.getItem(storageKey) ?? `UV${Math.floor(10000 + Math.random() * 90000)}`;
    localStorage.setItem(storageKey, visitorId);
    const send = (event: string, details: Record<string, unknown> = {}) => {
      void fetch("/api/dev-events", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, visitorId, path: window.location.pathname, ...details }) }).catch(() => undefined);
    };
    const onClick = (event: MouseEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("button, a, select, input, textarea, [role='button']");
      if (target) send("click", { target: target.tagName.toLowerCase(), field: target.getAttribute("name") ?? target.getAttribute("aria-label") ?? undefined });
    };
    const onInput = (event: Event) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) send("input_changed", { target: target.tagName.toLowerCase(), field: target.name || target.type || "unnamed", valueLength: target.value.length });
    };
    send("page_view");
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    return () => { document.removeEventListener("click", onClick); document.removeEventListener("input", onInput); };
  }, []);
}

function App() {
  useImageProtection();
  useDevAudit();
  const isMailHost = window.location.hostname === "mailsystem.afeonbooks.com";
  return (
    <QueryClientProvider client={queryClient}>
      <UtmProvider>
        <AuthProvider>
        <CartProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              {!isMailHost && <StatusBanner />}
              {isMailHost ? <MailSystemAccessGate><Router /></MailSystemAccessGate> : <Router />}
            </WouterRouter>
            <Toaster />
            {!isMailHost && <CookieBanner />}
          </TooltipProvider>
        </CartProvider>
        </AuthProvider>
      </UtmProvider>
    </QueryClientProvider>
  );
}

export default App;
