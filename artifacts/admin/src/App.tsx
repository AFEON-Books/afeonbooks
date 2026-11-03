import { useEffect, useState, type FormEvent } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Editor from "@/pages/editor";
import Pos from "@/pages/pos";
import Dev from "@/pages/dev";
import ZohoMail from "@/pages/zoho-mail";
import { MaintenancePage } from "@/pages/maintenance";

const queryClient = new QueryClient();

function DebugOverlay() {
  const [altPressed, setAltPressed] = useState(false);
  const [info, setInfo] = useState<{ build: string; ip: string } | null>(null);
  const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Alt") setAltPressed(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") setAltPressed(false);
    };
    const onBlur = () => setAltPressed(false);
    const onResize = () => setDimensions({ width: window.innerWidth, height: window.innerHeight });

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    if (!altPressed || info) return;
    let cancelled = false;
    fetch("/api/debug-info", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ build?: string; ip?: string }>)
      .then((data) => {
        if (!cancelled) setInfo({ build: data.build ?? "unknown", ip: data.ip ?? "unknown" });
      })
      .catch(() => {
        if (!cancelled) setInfo({ build: "unknown", ip: "unknown" });
      });
    return () => { cancelled = true; };
  }, [altPressed, info]);

  if (!altPressed) return null;

  return (
    <div
      style={{ position: "fixed", top: 8, right: 8, zIndex: 2147483647 }}
      className="pointer-events-none select-none bg-black text-white px-3 py-2 font-mono text-xs leading-5 shadow-lg"
    >
      <div>dimensions: {dimensions.width}×{dimensions.height}</div>
      <div>build #: {info?.build ?? "loading…"}</div>
      <div>ip: {info?.ip ?? "loading…"}</div>
    </div>
  );
}

function OrderEmailOverlay() {
  const [orderId, setOrderId] = useState<number | null>(null);
  const [order, setOrder] = useState<{ id: number; customerName: string; customerEmail: string; totalCents: number; currency: string; status: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [accountExists, setAccountExists] = useState<boolean | null>(null);
  const [accountFormOpen, setAccountFormOpen] = useState(false);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountSearchResults, setAccountSearchResults] = useState<Array<{ id: number; name: string; email: string }>>([]);
  const [accountSearchDone, setAccountSearchDone] = useState(false);
  const [createAccountFormOpen, setCreateAccountFormOpen] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);

  useEffect(() => {
    const onClick = async (event: MouseEvent) => {
      const target = event.target as Element | null;
      const control = target?.closest<HTMLElement>("button, a, select, input, textarea");
      if (control) return;

      const row = target?.closest<HTMLTableRowElement>("tr");
      if (!row) return;
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 7) return;
      const firstText = cells[0]?.textContent?.trim() ?? "";
      const match = firstText.match(/^#(\d+)$/);
      if (!match) return;

      const id = Number(match[1]);
      if (!Number.isInteger(id)) return;
      setOrderId(id);
      setMessage("");
      setOrder(null);
      setAccountExists(null);
      setAccountFormOpen(false);
      setCreateAccountFormOpen(false);
      setAccountSearch("");
      setAccountSearchResults([]);
      setAccountSearchDone(false);

      try {
        const response = await fetch(`/api/orders/${id}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setOrder({
          id: data.id,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          totalCents: data.totalCents,
          currency: data.currency,
          status: data.status,
        });
        setAccountName(data.customerName ?? "");
        setAccountEmail(data.customerEmail ?? "");
        const accountResponse = await fetch(`/api/auth/users/by-email?email=${encodeURIComponent(data.customerEmail ?? "")}`, { cache: "no-store" });
        if (accountResponse.ok) {
          const accountData = await accountResponse.json() as { user?: unknown };
          setAccountExists(Boolean(accountData.user));
        }
      } catch {
        setMessage("Could not load order details.");
      }
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  if (orderId === null) return null;

  const close = () => {
    if (sending) return;
    setOrderId(null);
    setOrder(null);
    setMessage("");
    setAccountExists(null);
    setAccountFormOpen(false);
    setCreateAccountFormOpen(false);
  };

  const searchAccounts = async (event: FormEvent) => {
    event.preventDefault();
    const query = accountSearch.trim();
    if (query.length < 2) return;
    setAccountBusy(true);
    setAccountSearchDone(false);
    try {
      const response = await fetch(`/api/auth/users/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const data = await response.json() as { users?: Array<{ id: number; name: string; email: string }> };
      if (!response.ok) throw new Error("Unable to search customers");
      setAccountSearchResults(data.users ?? []);
      setAccountSearchDone(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to search customers");
    } finally {
      setAccountBusy(false);
    }
  };

  const resend = async () => {
    if (!orderId) return;
    setSending(true);
    setMessage("");
    try {
      const response = await fetch(`/api/orders/${orderId}/resend-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
      setMessage(data.message ?? "Email resent successfully.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to resend email.");
    } finally {
      setSending(false);
    }
  };

  const createAccount = async (event: FormEvent) => {
    event.preventDefault();
    setAccountBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/admin/create-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName, email: accountEmail }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setAccountExists(true);
      setAccountFormOpen(false);
      setMessage("Account created. A password setup email was sent to the customer.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create account");
    } finally {
      setAccountBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2147483646] flex items-center justify-center bg-black/30 px-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="w-full max-w-md bg-white border border-black/10 shadow-2xl p-6 font-sans">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <p className="text-xs uppercase tracking-widest font-bold text-black/40">Order</p>
            <h2 className="text-2xl font-bold mt-1">#{orderId}</h2>
          </div>
          <button type="button" onClick={close} className="text-black/40 hover:text-black text-xl leading-none" aria-label="Close">×</button>
        </div>

        {order ? (
          <div className="space-y-4 text-sm">
            <div><div className="text-xs uppercase tracking-widest text-black/40">Customer</div><div className="font-medium mt-1">{order.customerName}</div></div>
            <div><div className="text-xs uppercase tracking-widest text-black/40">Email</div><div className="mt-1">{order.customerEmail}</div></div>
            {accountExists === false && !accountFormOpen && (
              <button type="button" onClick={() => { setAccountFormOpen(true); setAccountSearchDone(false); setAccountSearchResults([]); }} className="w-full border border-black/20 py-3 text-xs font-bold uppercase tracking-widest hover:bg-[#FAF7F2]">
                Add customer account
              </button>
            )}
            {accountExists === true && <p className="text-xs font-bold uppercase tracking-widest text-emerald-700">Customer account linked</p>}
            {accountFormOpen && (
              <div className="space-y-3 border border-black/10 bg-[#FAF7F2] p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-black/50">Search customer accounts</p>
                <form onSubmit={searchAccounts} className="flex gap-2">
                  <input value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} placeholder="Name or email" className="min-w-0 flex-1 border border-black/15 bg-white px-3 py-2 outline-none focus:border-black" />
                  <button type="submit" disabled={accountBusy} className="bg-black px-3 py-2 text-xs font-bold uppercase tracking-widest text-white disabled:opacity-40">Search</button>
                </form>
                {accountSearchDone && accountSearchResults.length > 0 && (
                  <div className="space-y-2">
                    {accountSearchResults.map((customer) => <div key={customer.id} className="border border-black/10 bg-white px-3 py-2 text-sm"><div className="font-medium">{customer.name}</div><div className="text-xs text-black/50">{customer.email}</div></div>)}
                  </div>
                )}
                {accountSearchDone && accountSearchResults.length === 0 && !createAccountFormOpen && (
                  <div className="space-y-2"><p className="text-xs text-black/55">No customer account found.</p><button type="button" onClick={() => { setAccountName(order?.customerName ?? ""); setAccountEmail(order?.customerEmail ?? ""); setCreateAccountFormOpen(true); }} className="w-full border border-black/20 py-2 text-xs font-bold uppercase tracking-widest hover:bg-white">Create new account</button></div>
                )}
                {createAccountFormOpen && (
                  <form onSubmit={createAccount} className="space-y-3 border-t border-black/10 pt-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-black/50">Create account for customer</p>
                    <input value={accountName} onChange={(event) => setAccountName(event.target.value)} required minLength={2} placeholder="Customer name" className="w-full border border-black/15 bg-white px-3 py-2 outline-none focus:border-black" />
                    <input value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} required type="email" placeholder="Customer email" className="w-full border border-black/15 bg-white px-3 py-2 outline-none focus:border-black" />
                    <p className="text-xs leading-5 text-black/55">The customer will receive an email with a secure link to set a password.</p>
                    <button type="submit" disabled={accountBusy} className="w-full bg-black py-2 text-xs font-bold uppercase tracking-widest text-white disabled:opacity-40">{accountBusy ? "Creating…" : "Create account"}</button>
                  </form>
                )}
                <button type="button" disabled={accountBusy} onClick={() => { setAccountFormOpen(false); setCreateAccountFormOpen(false); }} className="w-full border border-black/20 px-3 py-2 text-xs font-bold uppercase tracking-widest">Close</button>
              </div>
            )}
            <div><div className="text-xs uppercase tracking-widest text-black/40">Total</div><div className="font-bold mt-1">{new Intl.NumberFormat("en-US", { style: "currency", currency: order.currency }).format(order.totalCents / 100)}</div></div>
            <div><div className="text-xs uppercase tracking-widest text-black/40">Status</div><div className="mt-1 capitalize">{order.status}</div></div>

            <button
              type="button"
              onClick={resend}
              disabled={sending}
              className="w-full mt-2 bg-black text-white py-3 text-xs font-bold uppercase tracking-widest disabled:opacity-40"
            >
              {sending ? "Resending…" : "Resend Email"}
            </button>

            {message && (
              <p className={`text-sm ${message.toLowerCase().includes("resent") || message.toLowerCase().includes("success") ? "text-emerald-700" : "text-red-600"}`}>
                {message}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-black/50">{message || "Loading order…"}</p>
        )}
      </div>
    </div>
  );
}

function AdminHome() {
  const [devOpen, setDevOpen] = useState(() => window.location.hash === "#dev");

  useEffect(() => {
    const onHashChange = () => setDevOpen(window.location.hash === "#dev");
    window.addEventListener("hashchange", onHashChange);

    const installAdminTools = () => {
      const tabs = Array.from(document.querySelectorAll("button")).filter((button) => {
        const text = button.textContent?.trim() ?? "";
        return text === "Site Content" || text === "Recent Orders";
      });
      const anchor = tabs[tabs.length - 1];
      const parent = anchor?.parentElement;
      if (!parent) return;

      if (!document.querySelector("[data-admin-dev-tab='true']")) {
        const devTab = document.createElement("button");
        devTab.type = "button";
        devTab.dataset.adminDevTab = "true";
        devTab.className = "pb-4 font-bold text-sm tracking-widest uppercase border-b-2 transition-colors border-transparent text-black/40 hover:text-black/80";
        devTab.textContent = "Dev";
        devTab.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          window.location.hash = "dev";
        });
        parent.appendChild(devTab);
      }

      if (!document.querySelector("[data-admin-zoho-tab='true']")) {
        const zohoTab = document.createElement("button");
        zohoTab.type = "button";
        zohoTab.dataset.adminZohoTab = "true";
        zohoTab.className = "pb-4 font-bold text-sm tracking-widest uppercase border-b-2 transition-colors border-transparent text-black/40 hover:text-black/80";
        zohoTab.textContent = "Zoho Mail";
        zohoTab.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          window.location.hash = "zoho-mail";
        });
        parent.appendChild(zohoTab);
      }

      // Keep the existing Email tab's provider wording aligned with the Zoho transport.
      document.querySelectorAll("input[name='emailFromAddress']").forEach((input) => {
        const el = input as HTMLInputElement;
        el.placeholder = "noreply@afeonbooks.com";
        if (el.value === "onboarding@resend.dev") {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(el, "noreply@afeonbooks.com");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const replacements: Array<[string, string]> = [
        ["Use any sender address at a domain verified in MailerSend.", "Sender address is managed by Zoho Mail. AFEON Books sends from noreply@afeonbooks.com."],
        ["MailerSend", "Zoho Mail"],
      ];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue ?? "";
        let next = text;
        for (const [from, to] of replacements) next = next.replaceAll(from, to);
        if (next !== text) node.nodeValue = next;
      }
    };

    installAdminTools();
    const observer = new MutationObserver(installAdminTools);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      window.removeEventListener("hashchange", onHashChange);
      observer.disconnect();
    };
  }, []);

  return devOpen ? <Dev /> : <Editor />;
}

function Router() {
  const MaintenanceRoute = () => {
    const fromAdminButton = new URLSearchParams(window.location.search).get("preview") === "1";
    if (!fromAdminButton && sessionStorage.getItem("afeonbooks_maintenance_preview") !== "true") return <NotFound />;
    sessionStorage.removeItem("afeonbooks_maintenance_preview");
    return <MaintenancePage />;
  };
  return (
    <Switch>
      <Route path="/maintenance" component={MaintenanceRoute} />
      <Route path="/maintenance/" component={MaintenanceRoute} />
      <Route path="/pos/" component={Pos} />
      <Route path="/pos" component={Pos} />
      <Route path="/zoho-mail" component={ZohoMail} />
      <Route path="/zoho-mail/" component={ZohoMail} />
      <Route path="/source-edit" component={AdminHome} />
      <Route path="/source-edit/" component={AdminHome} />
      <Route path="/" component={AdminHome} />
      <Route component={NotFound} />
    </Switch>
  );
}

function StatusEditRedirect() {
  useEffect(() => {
    window.location.replace("https://manage.statuspage.io/pages/rrymp485zp6s/incidents");
  }, []);

  return null;
}

function AdminAccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"loading" | "signed-out" | "denied" | "allowed">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/admin/access", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { error?: string };
        if (response.status === 401) {
          if (!cancelled) setStatus("signed-out");
          return;
        }
        if (response.status === 403) {
          if (!cancelled) setError(data.error ?? "");
          if (!cancelled) setStatus("denied");
          return;
        }
        if (!response.ok) throw new Error(data.error ?? "Unable to verify staff access");
        if (!cancelled) setStatus("allowed");
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to verify staff access");
          setStatus("denied");
        }
      });
    return () => { cancelled = true; };
  }, []);

  if (status === "loading") return <main className="min-h-screen flex items-center justify-center">Checking staff access…</main>;
  if (status === "signed-out") {
    const signInUrl = new URL("https://afeonbooks.com/api/auth/github/start");
    signInUrl.searchParams.set("return_to", window.location.href);
    return (
      <main className="min-h-screen flex items-center justify-center bg-background px-6 text-center">
        <div>
          <h1 className="text-xl font-semibold">Sign in with GitHub</h1>
          <p className="mt-2 text-sm text-muted-foreground">Use your AFEON-Books organization account linked to a verified AFEON staff or admin account.</p>
          <a className="mt-5 inline-block rounded bg-primary px-5 py-3 text-primary-foreground" href={signInUrl.toString()}>Continue with GitHub</a>
        </div>
      </main>
    );
  }
  if (status === "denied") {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background px-6 text-center">
        <div>
          <h1 className="text-xl font-semibold">Staff access required</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error || "This GitHub account is not linked to an AFEON account with the staff or admin role."}</p>
          <a className="mt-5 inline-block rounded border px-5 py-3" href={new URL(`/api/auth/github/start?return_to=${encodeURIComponent(window.location.href)}`, "https://afeonbooks.com").toString()}>Try another GitHub account</a>
        </div>
      </main>
    );
  }
  return <>{children}</>;
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
  useDevAudit();
  const adminBase = "/admin";
  const isPosPath = window.location.pathname === `${adminBase}/pos` || window.location.pathname === `${adminBase}/pos/`;
  const isZohoMailPath = window.location.pathname === `${adminBase}/zoho-mail` || window.location.pathname === `${adminBase}/zoho-mail/`;
  const isStatusEditPath = window.location.pathname === `${adminBase}/status-edit` || window.location.pathname === `${adminBase}/status-edit/`;
  const [adminView, setAdminView] = useState(() => window.location.hash);

  useEffect(() => {
    const onHashChange = () => setAdminView(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const control = target?.closest<HTMLElement>("button, a");
      if (!control) return;

      const label = control.textContent?.replace(/\s+/g, " ").trim().toUpperCase();
      if (label !== "POS CHECKOUT") return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      window.location.assign(`${window.location.origin}${adminBase}/pos/`);
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {isStatusEditPath ? (
          <StatusEditRedirect />
        ) : (
          <AdminAccessGate>
            {isPosPath ? (
              <Pos />
            ) : isZohoMailPath || adminView === "#zoho-mail" ? (
              <ZohoMail />
            ) : (
              <WouterRouter base={adminBase}>
                <Router />
              </WouterRouter>
            )}
            {!isPosPath && !isZohoMailPath && <OrderEmailOverlay />}
            <DebugOverlay />
          </AdminAccessGate>
        )}
        <Toaster position="top-center" richColors />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
