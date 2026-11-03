import { FormEvent, useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, FileText, Gift, LogOut } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { Button } from "@/components/ui/button";
import { authApiRequest, createAuthEntryUrl, useAuth, type User } from "@/lib/auth";
import { formatPrice } from "@/lib/format";
import { TurnstileWidget } from "@/components/turnstile-widget";

type MyOrder = {
  id: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  city: string;
  postalCode: string;
  country: string;
  classroom?: string;
  useDefaultAddress: boolean;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  items: Array<{ id: number; productName: string; quantity: number; unitPriceCents: number }>;
};

type LoyaltyData = {
  balance: number;
  transactions: Array<{ id: number; points: number; description: string; createdAt: string }>;
};

function getAllowedReturnUrl(value: string | null): string | null {
  if (!value) return null;

  try {
    const target = new URL(value);
    const allowed = target.origin === "https://mailsystem.afeonbooks.com"
      || (target.origin === "https://source.afeonbooks.com" && ["/", "/source", "/infra"].includes(target.pathname))
      || (target.origin === "https://afeonbooks.com" && (target.pathname === "/admin" || target.pathname.startsWith("/admin/")));
    if (!allowed || target.username || target.password) {
      return null;
    }
    return target.toString();
  } catch {
    return null;
  }
}

function AccountForm() {
  const { signIn, signUp } = useAuth();
  const [step, setStep] = useState<"email" | "code" | "password" | "signup" | "forgot" | "verification">("email");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const action = step === "forgot" ? "password_reset" : step === "signup" ? "signup" : step === "verification" ? "resend_verification" : "login";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!turnstileToken) {
      setError("Complete the security check.");
      return;
    }
    setBusy(true);
    try {
      if (step === "email") {
        const data = await authApiRequest<{ accountFound: boolean; codeSent?: boolean; requiresVerification?: boolean }>("/api/auth/email-lookup", {
          method: "POST",
          body: JSON.stringify({ email, "cf-turnstile-response": turnstileToken }),
        });
        setMessage("");
        if (!data.accountFound) setStep("signup");
        else if (data.requiresVerification) setStep("verification");
        else if (data.codeSent) setStep("code");
      } else if (step === "code") {
        await authApiRequest<{ user: User }>("/api/auth/email-code/verify", {
          method: "POST",
          body: JSON.stringify({ email, code, "cf-turnstile-response": turnstileToken }),
        });
        window.location.reload();
      } else if (step === "password") {
        await signIn(email, password, turnstileToken);
      } else if (step === "signup") {
        await signUp(name, email, password, turnstileToken);
        setMessage("Check your email to verify your account before signing in.");
      } else if (step === "forgot") {
        const data = await authApiRequest<{ message: string }>("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email, "cf-turnstile-response": turnstileToken }) });
        setMessage(data.message);
      } else if (step === "verification") {
        const data = await authApiRequest<{ message: string }>("/api/auth/resend-verification", {
          method: "POST",
          body: JSON.stringify({ email, "cf-turnstile-response": turnstileToken }),
        });
        setMessage(data.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to continue");
    } finally {
      setBusy(false);
      setTurnstileToken("");
      setTurnstileResetKey((key) => key + 1);
    }
  };

  const backToEmail = () => {
    setStep("email");
    setPassword("");
    setCode("");
    setError("");
    setMessage("");
  };

  const title = step === "email" ? "Continue with email"
    : step === "code" ? "Enter your email code"
      : step === "password" ? "Sign in with password"
        : step === "signup" ? "Create your account"
          : step === "forgot" ? "Reset your password"
            : "Verify your email";

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <form onSubmit={submit} className="space-y-5">
        <h2 className="text-xl font-bold">{title}</h2>
        {step === "signup" && <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Full name" required className="w-full border border-black/15 bg-white px-4 py-3 outline-none focus:border-black" />}
        {step === "email" || step === "signup" || step === "verification" ? (
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" required readOnly={step !== "email"} className="w-full border border-black/15 bg-white px-4 py-3 outline-none focus:border-black read-only:bg-black/[0.03]" />
        ) : null}
        {(step === "password" || step === "signup") && (
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" minLength={8} required className="w-full border border-black/15 bg-white px-4 py-3 outline-none focus:border-black" />
        )}
        {step === "code" && (
          <>
            <p className="text-sm text-black/60">We sent a five-digit sign-in code to {email}. It expires in 10 minutes.</p>
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="5-digit code" required className="w-full border border-black/15 bg-white px-4 py-3 font-mono tracking-[0.3em] outline-none focus:border-black" />
          </>
        )}
        {step === "verification" && <p className="text-sm text-black/60">This account has not verified its email yet. Resend the verification link to continue.</p>}
        <TurnstileWidget action={action} onToken={setTurnstileToken} resetKey={turnstileResetKey} />
        {error && <p className="text-sm text-red-700">{error}</p>}
        {message && <p className="text-sm text-emerald-700">{message}</p>}
        <Button type="submit" disabled={busy} className="w-full rounded-none bg-black py-6 text-xs font-bold uppercase tracking-widest text-white hover:bg-black/80">
          {busy ? "Please wait..." : step === "email" ? "Continue with email" : step === "code" ? "Sign in with code" : step === "password" ? "Sign in" : step === "signup" ? "Create account" : step === "forgot" ? "Send reset link" : "Resend verification email"}
        </Button>
      </form>

      {step === "email" ? (
        <a href={`https://afeonbooks.com/api/auth/github/start?return_to=${encodeURIComponent("https://afeonbooks.com/admin/")}`} className="block w-full border border-black/20 bg-white px-4 py-4 text-center text-xs font-bold uppercase tracking-widest hover:bg-black/[0.03]">
          Staff and admin: continue with GitHub
        </a>
      ) : null}
      {step === "code" && <button type="button" onClick={() => { setStep("password"); setError(""); setMessage(""); }} className="w-full text-sm text-black/55 underline underline-offset-4">Login with Password</button>}
      {step === "password" && <button type="button" onClick={() => { setStep("forgot"); setError(""); setMessage(""); }} className="w-full text-sm text-black/55 underline underline-offset-4">Forgot password?</button>}
      {step !== "email" && <button type="button" onClick={backToEmail} className="w-full text-sm text-black/55 underline underline-offset-4">Use a different email</button>}
    </div>
  );
}

function AccountTokenHandler() {
  const { user, loading } = useAuth();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [resendMessage, setResendMessage] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resendToken, setResendToken] = useState("");
  const [resendResetKey, setResendResetKey] = useState(0);
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get("verify_token");
  const resetToken = params.get("reset_token");

  useEffect(() => {
    if (!verifyToken) return;
    authApiRequest<{ user: User }>("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verifyToken }) })
      .then(() => { window.location.replace("/account"); })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to verify email"));
  }, [verifyToken]);

  const resendVerification = async (event: FormEvent) => {
    event.preventDefault();
    setResendMessage("");
    if (!resendToken) {
      setResendMessage("Complete the security check.");
      return;
    }
    try {
      const data = await authApiRequest<{ message: string }>("/api/auth/resend-verification", { method: "POST", body: JSON.stringify({ email: verificationEmail, "cf-turnstile-response": resendToken }) });
      setResendMessage(data.message);
    } catch (err) {
      setResendMessage(err instanceof Error ? err.message : "Unable to resend verification email");
    } finally {
      setResendToken("");
      setResendResetKey((key) => key + 1);
    }
  };

  if (resetToken) {
    return <form onSubmit={async (event) => { event.preventDefault(); setError(""); try { await authApiRequest<{ user: User }>("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token: resetToken, password: resetPassword }) }); window.location.replace("/account"); } catch (err) { setError(err instanceof Error ? err.message : "Unable to reset password"); } }} className="mx-auto mt-8 w-full max-w-md space-y-4"><h2 className="text-2xl font-bold">Choose a new password</h2><input type="password" minLength={8} required value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="New password" className="w-full border border-black/15 bg-white px-4 py-3" />{error && <p className="text-sm text-red-700">{error}</p>}<Button type="submit" className="w-full rounded-none bg-black py-6 text-xs font-bold uppercase tracking-widest text-white">Update password</Button></form>;
  }
  if (loading || (!verifyToken && !message && !error) || user) return null;
  return <div className="mx-auto mt-8 max-w-md text-sm">{message && <p className="text-emerald-700">{message}</p>}{error && <><p className="text-red-700">{error}</p><form onSubmit={resendVerification} className="mt-5 space-y-3"><input type="email" required value={verificationEmail} onChange={(event) => setVerificationEmail(event.target.value)} placeholder="Email address" className="w-full border border-black/15 bg-white px-4 py-3" /><TurnstileWidget action="resend_verification" onToken={setResendToken} resetKey={resendResetKey} /><Button type="submit" variant="outline" className="w-full rounded-none text-xs font-bold uppercase tracking-widest">Resend verification email</Button>{resendMessage && <p className="text-black/60">{resendMessage}</p>}</form></>}</div>;
}

function OrdersPanel() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;

    authApiRequest<MyOrder[]>("/api/orders/mine")
      .then((data) => setOrders(data))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load orders"))
      .finally(() => setLoading(false));
  }, [user]);

  if (!user) return null;

  return (
    <section className="mt-16 border-t border-black/10 pt-10">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h2 className="text-2xl font-bold">Past orders</h2>
      </div>

      {error && <p className="mb-4 text-sm text-red-700">{error}</p>}
      {loading ? (
        <p className="text-black/50">Loading your orders...</p>
      ) : orders.length === 0 ? (
        <p className="text-black/60">You haven’t placed any orders yet.</p>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <div key={order.id} className="border border-black/10 bg-white p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-black/40">Order #{order.id}</p>
                  <p className="mt-2 text-sm text-black/60">{new Date(order.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs font-bold uppercase tracking-[0.2em] text-black/50">{order.status}</span>
                  <span className="text-lg font-bold">{formatPrice(order.totalCents, order.currency)}</span>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-black/60">
                <span>{order.items.reduce((sum, item) => sum + item.quantity, 0)} item(s)</span>
                <span>•</span>
                <span>{order.items.map((item) => item.productName).slice(0, 2).join(", ")}{order.items.length > 2 ? "…" : ""}</span>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <Button asChild variant="outline" className="rounded-none border-black/20 text-xs font-bold uppercase tracking-widest">
                  <Link href={`/order/${order.id}`}>View order</Link>
                </Button>
                <Button type="button" variant="outline" className="rounded-none border-black/20 text-xs font-bold uppercase tracking-widest" onClick={() => window.open(`/order/${order.id}/pdf`, "_blank", "noopener,noreferrer") }>
                  <FileText className="mr-2 h-4 w-4" /> PDF
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LoyaltyPanel() {
  const { user } = useAuth();
  const [loyalty, setLoyalty] = useState<LoyaltyData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    authApiRequest<LoyaltyData>("/api/auth/loyalty")
      .then(setLoyalty)
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load Pages"));
  }, [user]);

  if (!user) return null;

  return (
    <section className="mt-16 border-t border-black/10 pt-10">
      <div className="flex flex-col gap-5 border border-black/10 bg-white p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <Gift className="mt-1 h-6 w-6" />
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-black/45">Pages</p>
            <h2 className="mt-2 text-2xl font-bold">{(loyalty?.balance ?? 0).toLocaleString()} Pages</h2>
            <p className="mt-2 text-sm text-black/60">Earn 10 Pages for every dollar on completed orders.</p>
          </div>
        </div>
        {(loyalty?.transactions.length ?? 0) > 0 && (
          <div className="text-sm text-black/60 sm:text-right">
            <p className="font-semibold text-black">Latest activity</p>
            <p className="mt-1">+{loyalty!.transactions[0].points} Pages</p>
          </div>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </section>
  );
}

export default function Account() {
  const { user, loading, signOut } = useAuth();
  const params = new URLSearchParams(window.location.search);
  const hasTokenFlow = params.has("reset_token") || params.has("verify_token");
  const returnToParam = params.get("return_to");
  const returnTo = getAllowedReturnUrl(returnToParam);
  const isAuthHost = window.location.hostname === "authn.afeonbooks.com";
  const isAuthEntry =
    isAuthHost ||
    window.location.pathname === "/account" ||
    window.location.pathname === "/account/" ||
    /^\/(?:sign-in|account-check)\/[a-f0-9]{32}$/.test(window.location.pathname);

  useEffect(() => {
    if (!loading && !user && !hasTokenFlow && !isAuthEntry) {
      window.location.replace(createAuthEntryUrl(false));
    }
  }, [isAuthEntry, isAuthHost, loading, user, hasTokenFlow]);

  const returnRequiresAdmin = returnTo
    ? new URL(returnTo).hostname === "mailsystem.afeonbooks.com" || new URL(returnTo).hostname === "source.afeonbooks.com"
    : false;
  const canReturn = user?.role === "admin" || (!returnRequiresAdmin && user?.role === "staff");

  useEffect(() => {
    if (isAuthHost && returnTo && !loading && canReturn) {
      window.location.replace(returnTo);
    }
  }, [canReturn, isAuthHost, loading, returnTo]);

  if (!loading && !user && !hasTokenFlow && !isAuthEntry) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[#FAF7F2]">
      <SiteHeader simple />

      <main className="mx-auto min-h-[70vh] max-w-[900px] px-6 py-16">
        <div className="mb-12">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-black/40">
            AFEON Books
          </p>

          <h1 className="mt-3 text-5xl font-bold tracking-tight">
            Your account
          </h1>
        </div>

        {hasTokenFlow ? (
          <AccountTokenHandler />
        ) : loading ? (
          <p className="text-black/50">Loading...</p>
        ) : isAuthHost && returnToParam && !returnTo ? (
          <p className="mx-auto mt-8 max-w-md text-sm text-red-700">This sign-in destination is not allowed.</p>
        ) : isAuthHost && returnTo && user && !canReturn ? (
          <div className="mx-auto mt-8 max-w-md text-center text-sm">
            <p className="text-red-700">This page requires an administrator account.</p>
            <Link href="/account" className="mt-3 inline-block underline underline-offset-4">
              Sign out or switch accounts
            </Link>
          </div>
        ) : user ? (
          <>
            <div className="flex flex-col justify-between gap-6 border-y border-black/10 py-8 sm:flex-row sm:items-center">
              <div>
                <p className="text-2xl font-bold">{user.name}</p>
                <p className="mt-1 text-black/55">{user.email}</p>
                <p className="mt-3 text-xs font-bold uppercase tracking-widest text-black/45">
                  {user.role}
                </p>
              </div>

              <Button
                onClick={signOut}
                variant="outline"
                className="w-fit rounded-none border-black/20"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </Button>
            </div>

            <LoyaltyPanel />
            <OrdersPanel />
          </>
        ) : (
          <AccountForm />
        )}

        <Link
          href="/shop"
          className="mt-12 inline-flex items-center gap-2 text-sm font-bold uppercase tracking-widest"
        >
          Continue shopping
          <ArrowRight className="h-4 w-4" />
        </Link>
      </main>

      <SiteFooter />
    </div>
  );
}
