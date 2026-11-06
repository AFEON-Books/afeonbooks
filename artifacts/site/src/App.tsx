import { useCallback, useEffect, useRef, useState } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Github } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TurnstileWidget } from "@/components/turnstile-widget";
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
  const { loading } = useAuth();
  const [location] = useLocation();
  const accessLocation = `${location}${window.location.hash}`;
  const [status, setStatus] = useState<"loading" | "signed-out" | "github-required" | "allowed">("loading");
  const [accessError, setAccessError] = useState("");
  const [turnstileOpen, setTurnstileOpen] = useState(false);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [popupError, setPopupError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    setStatus("loading");
    setAccessError("");
    fetch("/api/auth/admin/access", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          if (!cancelled) setStatus("signed-out");
          return;
        }
        if (response.status === 403) {
          if (!cancelled) setStatus("github-required");
          return;
        }
        if (!response.ok) throw new Error("Unable to verify mailbox access");
        if (!cancelled) setStatus("allowed");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setAccessError(cause instanceof Error ? cause.message : "Unable to verify mailbox access");
        setStatus("github-required");
      });
    return () => { cancelled = true; };
  }, [accessLocation, loading]);

  const handleTurnstileToken = useCallback((token: string) => {
    if (!token) return;
    const form = formRef.current;
    const targetName = `afeonbooks-github-${crypto.randomUUID()}`;
    const githubWindow = window.open("about:blank", targetName);
    if (!githubWindow) {
      setPopupError("Your browser blocked the GitHub tab. Allow pop-ups and try the security check again.");
      setTurnstileResetKey((current) => current + 1);
      return;
    }
    if (!form || !tokenInputRef.current) {
      githubWindow.close();
      setPopupError("Unable to start GitHub sign-in. Please try again.");
      return;
    }
    tokenInputRef.current.value = token;
    form.target = targetName;
    form.submit();
    setTurnstileOpen(false);
    setPopupError("");
  }, []);

  if (status === "allowed") return <>{children}</>;
  if (status === "loading" || loading) return <main className="flex min-h-screen items-center justify-center">Checking mailbox access…</main>;
  return (
    <>
      <main className="flex min-h-screen items-center justify-center bg-[#FAF7F2] px-6 text-center">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-semibold">Sign in with GitHub</h1>
          <p className="mt-2 text-sm text-black/60">Use a GitHub account that belongs to the AFEON Books organization.</p>
          <button type="button" onClick={() => { setPopupError(""); setTurnstileOpen(true); }} className="mt-6 inline-flex items-center gap-3 rounded-md bg-[#24292f] px-5 py-3 font-semibold text-white hover:bg-[#32383f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24292f]">
            <Github aria-hidden="true" size={20} />
            Sign in with GitHub
          </button>
          {accessError && <p role="alert" className="mt-3 text-sm text-red-700">{accessError}</p>}
        </div>
      </main>
      <Dialog open={turnstileOpen} onOpenChange={setTurnstileOpen}>
        <DialogContent className="w-[min(94vw,360px)] gap-2 p-5">
          <DialogTitle className="sr-only">Turnstile security check</DialogTitle>
          <DialogDescription className="sr-only">Complete the security check to continue to GitHub.</DialogDescription>
          <TurnstileWidget action="staff_github_login" onToken={handleTurnstileToken} resetKey={turnstileResetKey} />
          <form ref={formRef} method="post" action="https://api.afeonbooks.com/api/auth/github/start">
            <input ref={tokenInputRef} type="hidden" name="cf-turnstile-response" />
            <input type="hidden" name="return_to" value={window.location.href} />
          </form>
          {popupError && <p role="alert" className="text-sm text-red-700">{popupError}</p>}
        </DialogContent>
      </Dialog>
    </>
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
  const isStaffAuthFlow = window.location.hostname === "authn.afeonbooks.com"
    && new URLSearchParams(window.location.search).has("return_to");
  return (
    <QueryClientProvider client={queryClient}>
      <UtmProvider>
        <AuthProvider>
        <CartProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              {!isMailHost && !isStaffAuthFlow && <StatusBanner />}
              {isMailHost ? <MailSystemAccessGate><Router /></MailSystemAccessGate> : <Router />}
            </WouterRouter>
            <Toaster />
            {!isMailHost && !isStaffAuthFlow && <CookieBanner />}
          </TooltipProvider>
        </CartProvider>
        </AuthProvider>
      </UtmProvider>
    </QueryClientProvider>
  );
}

export default App;
