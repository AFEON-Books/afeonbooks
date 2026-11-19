import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, Route, Switch, Link } from "wouter";
import { StaffDashboard } from "./StaffDashboard";
import { POSCheckout } from "./POSCheckout";
import { SalesDashboard } from "./SalesDashboard";

const queryClient = new QueryClient();

const AFEONBOOKS_API = import.meta.env.VITE_API_BASE ?? "/api";
const appBasePath = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type Step = "lookup" | "choose" | "confirm" | "success" | "not-found" | "error";

interface OrderItem {
  id: number;
  productName: string;
  quantity: number;
  unitPriceCents: number;
}

interface Order {
  id: number;
  customerName: string;
  classroom: string;
  notes: string;
  totalCents: number;
  items: OrderItem[];
}

const inputClass =
  "w-full border border-black/15 bg-white px-4 py-3 text-sm font-medium text-black placeholder-black/25 focus:outline-none focus:border-black transition-colors disabled:opacity-40 rounded-none";

function Logo() {
  return (
    <img
      src={`${appBasePath}/afeonbooks-logo.png`}
      alt="AFEON Books"
      className="h-9 w-9 rounded-full object-cover"
    />
  );
}

function formatCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function PickupApp() {
  const [step, setStep] = useState<Step>("lookup");
  const [orderInput, setOrderInput] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [results, setResults] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = orderInput.trim();
    if (!raw) return;

    setLoading(true);
    setErrorMsg("");

    try {
      const res = await fetch(`${AFEONBOOKS_API}/orders`);
      if (!res.ok) throw new Error("Could not reach the order system.");
      const orders: Order[] = await res.json();

      const needle = raw.replace(/^#/, "").toLowerCase();
      const matches = orders.filter(
        (o) =>
          String(o.id) === needle ||
          o.customerName.toLowerCase().includes(needle)
      );

      if (matches.length === 1) {
        setOrder(matches[0]);
        setStep("confirm");
      } else if (matches.length > 1) {
        setResults(matches);
        setStep("choose");
      } else {
        setStep("not-found");
      }
    } catch {
      setErrorMsg("Unable to connect to the order system. Please try again.");
      setStep("error");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!order) return;
    setNotifyLoading(true);
    setErrorMsg("");

    const lines = [
      `Order #${order.id} is here for pickup!`,
      `Customer: ${order.customerName}`,
      order.classroom ? `Classroom: ${order.classroom}` : null,
      `Items: ${order.items.map((i) => `${i.productName} ×${i.quantity}`).join(", ")}`,
      `Total: ${formatCents(order.totalCents)}`,
      order.notes ? `Notes: ${order.notes}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const res = await fetch("https://ntfy.sh/afeonbooks-pickup", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Title: `Pickup - Order #${order.id} (${order.customerName.replace(/[^\x00-\xFF]/g, "?")})`,
          Priority: "high",
          Tags: "books,bell",
        },
        body: lines,
      });

      if (!res.ok) throw new Error(`Notification failed (${res.status})`);
      setStep("success");
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setNotifyLoading(false);
    }
  };

  const reset = () => {
    setStep("lookup");
    setOrderInput("");
    setOrder(null);
    setResults([]);
    setErrorMsg("");
  };

  const pickOrder = (o: Order) => {
    setOrder(o);
    setStep("confirm");
  };

  return (
    <div className="min-h-screen w-full flex flex-col font-sans bg-[#FAF7F2]">
      {/* Nav */}
      <header className="border-b border-black/10 px-6 md:px-12 h-16 flex items-center justify-between">
        <a
          href={import.meta.env.BASE_URL ?? "/pickup/"}
          className="flex items-center gap-3 text-base font-bold uppercase tracking-widest"
        >
          <Logo />
          AFEON Books
        </a>
        <span className="text-xs uppercase tracking-widest font-bold text-black/40">
          Order Pickup
        </span>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-lg">

          {/* ── STEP 1: Lookup ── */}
          {step === "lookup" && (
            <>
              <p className="text-amber-800 font-semibold text-sm uppercase tracking-widest mb-4">
                Curbside Pickup
              </p>
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-black mb-4 leading-[1.05]">
                I'm here for my order.
              </h1>
              <p className="text-black/60 text-base font-medium mb-10">
                Enter your order number and we'll pull up your details.
              </p>

              <form onSubmit={handleLookup} className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs uppercase tracking-widest font-bold text-black/50">
                    Order Number or Name
                  </label>
                  <input
                    type="text"
                    value={orderInput}
                    onChange={(e) => setOrderInput(e.target.value)}
                    placeholder="Order number or your name"
                    disabled={loading}
                    required
                    className={inputClass}
                    autoFocus
                  />
                </div>

                {errorMsg && (
                  <p className="text-red-600 text-sm font-medium">{errorMsg}</p>
                )}

                <div className="pt-1">
                  <button
                    type="submit"
                    disabled={loading || !orderInput.trim()}
                    className="rounded-none bg-black hover:bg-amber-800 text-white px-12 py-4 font-bold uppercase tracking-widest text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-3"
                  >
                    {loading ? (
                      <>
                        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Looking up order...
                      </>
                    ) : (
                      "Look Up Order"
                    )}
                  </button>
                </div>
              </form>
            </>
          )}

          {/* ── STEP 2: Choose from multiple results ── */}
          {step === "choose" && (
            <>
              <p className="text-amber-800 font-semibold text-sm uppercase tracking-widest mb-4">
                Multiple Orders Found
              </p>
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-black mb-4 leading-[1.05]">
                Which one is yours?
              </h1>
              <p className="text-black/60 text-base font-medium mb-8">
                We found {results.length} matching orders. Tap the one that looks right to you.
              </p>

              <div className="flex flex-col gap-3 mb-8">
                {results.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => pickOrder(o)}
                    className="border border-black/15 bg-white hover:border-black hover:bg-black/[0.02] transition-colors text-left px-5 py-4"
                  >
                    <div className="flex items-baseline justify-between gap-4 mb-1">
                      <span className="text-sm font-bold text-black">
                        #{o.id} — {o.customerName}
                      </span>
                      <span className="text-xs font-bold text-amber-800">
                        {formatCents(o.totalCents)}
                      </span>
                    </div>
                    <div className="text-xs text-black/50">
                      {o.items.map((i) => `${i.productName} ×${i.quantity}`).join(", ")}
                    </div>
                    {o.classroom && (
                      <div className="text-xs text-black/30 mt-1">Classroom: {o.classroom}</div>
                    )}
                  </button>
                ))}
              </div>

              <button
                onClick={reset}
                className="text-xs uppercase tracking-widest font-bold text-black/40 hover:text-black transition-colors"
              >
                Try Again
              </button>
            </>
          )}

          {/* ── STEP 3: Confirm ── */}
          {step === "confirm" && order && (
            <>
              <p className="text-amber-800 font-semibold text-sm uppercase tracking-widest mb-4">
                Order Found
              </p>
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-black mb-4 leading-[1.05]">
                Is this you?
              </h1>
              <p className="text-black/60 text-base font-medium mb-8">
                Check that the details below are correct, then press confirm to alert staff.
              </p>

              <div className="border border-black/15 bg-white divide-y divide-black/10 mb-8">
                <Row label="Order" value={`#${order.id}`} bold />
                <Row label="Name" value={order.customerName} />
                {order.classroom && <Row label="Classroom" value={order.classroom} />}
                <div className="px-5 py-4 flex items-start gap-4">
                  <span className="text-xs uppercase tracking-widest font-bold text-black/40 w-28 shrink-0 pt-0.5">
                    Items
                  </span>
                  <div className="flex flex-col gap-1">
                    {order.items.map((item) => (
                      <div key={item.id} className="text-sm font-medium text-black">
                        {item.productName}
                        <span className="text-black/40 ml-2">×{item.quantity}</span>
                        <span className="text-black/40 ml-2">{formatCents(item.unitPriceCents * item.quantity)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <Row label="Total" value={formatCents(order.totalCents)} bold />
                {order.notes && <Row label="Notes" value={order.notes} />}
              </div>

              {errorMsg && (
                <p className="text-red-600 text-sm font-medium mb-6">{errorMsg}</p>
              )}

              <div className="flex items-center gap-4">
                <button
                  onClick={handleConfirm}
                  disabled={notifyLoading}
                  className="rounded-none bg-black hover:bg-amber-800 text-white px-10 py-4 font-bold uppercase tracking-widest text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-3"
                >
                  {notifyLoading ? (
                    <>
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Notifying Staff...
                    </>
                  ) : (
                    "Confirm — Notify Staff"
                  )}
                </button>
                <button
                  onClick={reset}
                  disabled={notifyLoading}
                  className="text-xs uppercase tracking-widest font-bold text-black/40 hover:text-black transition-colors"
                >
                  Try Again
                </button>
              </div>
            </>
          )}

          {/* ── Not Found ── */}
          {step === "not-found" && (
            <>
              <p className="text-red-600 font-semibold text-sm uppercase tracking-widest mb-4">
                Order Not Found
              </p>
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-black mb-4 leading-[1.05]">
                We couldn't find that order.
              </h1>
              <p className="text-black/60 text-base font-medium mb-10">
                Double-check the order number from your confirmation email and try again.
              </p>
              <button
                onClick={reset}
                className="rounded-none bg-black hover:bg-amber-800 text-white px-10 py-4 font-bold uppercase tracking-widest text-xs transition-colors"
              >
                Try Again
              </button>
            </>
          )}

          {/* ── Error ── */}
          {step === "error" && (
            <>
              <p className="text-red-600 font-semibold text-sm uppercase tracking-widest mb-4">
                Connection Error
              </p>
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-black mb-4 leading-[1.05]">
                Something went wrong.
              </h1>
              <p className="text-black/60 text-base font-medium mb-10">
                {errorMsg || "Unable to reach the order system. Please try again."}
              </p>
              <button
                onClick={reset}
                className="rounded-none bg-black hover:bg-amber-800 text-white px-10 py-4 font-bold uppercase tracking-widest text-xs transition-colors"
              >
                Try Again
              </button>
            </>
          )}

          {/* ── Success ── */}
          {step === "success" && order && (
            <>
              <p className="text-amber-800 font-semibold text-sm uppercase tracking-widest mb-4">
                Staff Notified
              </p>
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-black mb-6 leading-[1.05]">
                Thank you — your order is finished.
              </h1>
              <p className="text-black/60 text-base font-medium mb-10">
                Our team has been alerted for Order #{order.id}. We'll bring your items out shortly.
              </p>

              <div className="border border-black/15 bg-white divide-y divide-black/10 mb-10">
                <Row label="Order" value={`#${order.id}`} bold />
                <Row label="Name" value={order.customerName} />
                {order.classroom && <Row label="Classroom" value={order.classroom} />}
                <div className="px-5 py-4 flex items-start gap-4">
                  <span className="text-xs uppercase tracking-widest font-bold text-black/40 w-28 shrink-0 pt-0.5">
                    Items
                  </span>
                  <div className="flex flex-col gap-1">
                    {order.items.map((item) => (
                      <div key={item.id} className="text-sm font-medium text-black">
                        {item.productName}
                        <span className="text-black/40 ml-2">×{item.quantity}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <button
                onClick={reset}
                className="rounded-none bg-black hover:bg-amber-800 text-white px-10 py-4 font-bold uppercase tracking-widest text-xs transition-colors"
              >
                New Pickup
              </button>
            </>
          )}

        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-black/10 px-6 md:px-12 h-12 flex items-center justify-between">
        <p className="text-xs uppercase tracking-widest font-bold text-black/30">
          © AFEON Books
        </p>
        <Link
          href="/admin"
          className="text-xs uppercase tracking-widest font-bold text-black/20 hover:text-black/50 transition-colors"
        >
          Staff →
        </Link>
      </footer>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="px-5 py-4 flex items-baseline gap-4">
      <span className="text-xs uppercase tracking-widest font-bold text-black/40 w-28 shrink-0">
        {label}
      </span>
      <span className={`text-sm text-black ${bold ? "font-bold" : "font-medium"}`}>
        {value}
      </span>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router base={appBasePath}>
        <Switch>
          <Route path="/admin/pos" component={POSCheckout} />
          <Route path="/admin/sales" component={SalesDashboard} />
          <Route path="/admin" component={StaffDashboard} />
          <Route component={PickupApp} />
        </Switch>
      </Router>
    </QueryClientProvider>
  );
}

export default App;
