import { useState } from "react";

const REQUIRED_ENV = [
  "ZOHO_CLIENT_ID",
  "ZOHO_CLIENT_SECRET",
  "ZOHO_MAIL_REFRESH_TOKEN",
  "ZOHO_MAIL_ACCOUNT_ID",
] as const;

export default function ZohoMail() {
  const [copied, setCopied] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{ ok?: boolean; message?: string; authenticatedUser?: string; fromAddress?: string; accountIdConfigured?: boolean; tokenRefreshSucceeded?: boolean } | null>(null);

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  };

  const checkZoho = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const response = await fetch("/api/email/zoho-diagnostic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      setStatus(data);
    } catch (error) {
      setStatus({ ok: false, message: error instanceof Error ? error.message : "Connection error" });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FAF7F2] font-sans allow-select">
      <header className="bg-white border-b border-black/10 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest font-bold text-black/40">Admin</p>
            <h1 className="text-2xl font-bold tracking-tight">Zoho Mail</h1>
          </div>
          <div className="flex items-center gap-3">
            <a href="/admin/" className="px-4 py-2 border border-black/20 text-xs font-bold uppercase tracking-widest hover:bg-black/5">Back to Admin</a>
            <a href="/admin/#email" className="px-4 py-2 bg-black text-white text-xs font-bold uppercase tracking-widest hover:bg-black/80">Email Templates</a>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
        <section className="bg-white border border-black/5 shadow-sm p-8">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <p className="text-xs uppercase tracking-widest font-bold text-emerald-700 mb-2">Provider</p>
              <h2 className="text-2xl font-bold">Zoho Mail API</h2>
              <p className="text-sm text-black/50 mt-2 max-w-2xl">AFEON Books sends transactional order email through Zoho Mail. OAuth credentials stay on the API server; they are never stored in this admin page.</p>
            </div>
            <div className="text-right text-sm">
              <div className="font-semibold">US data center</div>
              <div className="text-black/50 font-mono text-xs mt-1">accounts.zoho.com</div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-6 mt-8">
            <Info label="Authenticated mailbox" value="aiden.chen@afeonbooks.com" />
            <Info label="Sender alias" value="noreply@afeonbooks.com" />
            <Info label="Zoho Accounts" value="https://accounts.zoho.com" mono />
            <Info label="Zoho Mail API" value="https://mail.zoho.com" mono />
          </div>
        </section>

        <section className="bg-white border border-black/5 shadow-sm p-8">
          <h2 className="text-xl font-bold border-b border-black/10 pb-4">Render environment variables</h2>
          <p className="text-sm text-black/50 mt-3">Create these on the API service in Render. Do not put the client secret or refresh token in GitHub.</p>
          <div className="mt-6 divide-y divide-black/10 border border-black/10">
            {REQUIRED_ENV.map((name) => (
              <div key={name} className="flex items-center justify-between gap-4 p-4">
                <code className="font-mono text-sm">{name}</code>
                <button type="button" onClick={() => copy(name, name)} className="text-xs font-bold uppercase tracking-widest text-black/40 hover:text-black">
                  {copied === name ? "Copied" : "Copy name"}
                </button>
              </div>
            ))}
          </div>
          <div className="mt-6 bg-black/[0.03] border border-black/10 p-4 text-sm leading-6">
            <div><strong>Optional:</strong> <code className="font-mono">ZOHO_MAIL_AUTHENTICATED_USER=aiden.chen@afeonbooks.com</code></div>
            <div><strong>Optional:</strong> <code className="font-mono">ZOHO_MAIL_FROM_ADDRESS=noreply@afeonbooks.com</code></div>
          </div>
        </section>

        <section className="bg-white border border-black/5 shadow-sm p-8">
          <h2 className="text-xl font-bold border-b border-black/10 pb-4">Server-side connection check</h2>
          <p className="text-sm text-black/50 mt-3">This refreshes the Zoho OAuth access token without sending an email. Access requires GitHub sign-in with an AFEON-Books member account assigned the AFEON staff or admin role.</p>
          <div className="flex flex-col md:flex-row gap-3 mt-5 max-w-xl">
            <button type="button" onClick={checkZoho} disabled={checking} className="h-11 px-5 bg-black text-white text-xs font-bold uppercase tracking-widest disabled:opacity-40">
              {checking ? "Checking…" : "Check Zoho"}
            </button>
          </div>
          {status && (
            <div className={`mt-5 border p-4 text-sm ${status.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>
              <div className="font-bold">{status.ok ? "Zoho Mail is connected" : "Zoho Mail check failed"}</div>
              {status.message && <div className="mt-1">{status.message}</div>}
              {status.authenticatedUser && <div className="mt-2">Mailbox: <strong>{status.authenticatedUser}</strong></div>}
              {status.fromAddress && <div>Sender: <strong>{status.fromAddress}</strong></div>}
              {typeof status.tokenRefreshSucceeded === "boolean" && <div>OAuth refresh: <strong>{status.tokenRefreshSucceeded ? "successful" : "failed"}</strong></div>}
            </div>
          )}
        </section>

        <section className="bg-white border border-black/5 shadow-sm p-8">
          <h2 className="text-xl font-bold border-b border-black/10 pb-4">Zoho setup</h2>
          <ol className="mt-5 space-y-4 text-sm leading-6 text-black/70">
            <li><strong>1.</strong> Open the Zoho API Console and create a server-based application (or a Self Client).</li>
            <li><strong>2.</strong> Authorize it for your <strong>aiden.chen@afeonbooks.com</strong> mailbox with the minimum mail-send scope required by the Zoho Mail API.</li>
            <li><strong>3.</strong> Generate an offline/refresh token and keep the client secret and refresh token private.</li>
            <li><strong>4.</strong> Put the four required values above into Render → API service → Environment.</li>
            <li><strong>5.</strong> Redeploy the API service, then use this page's connection check.</li>
          </ol>
        </section>
      </main>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="border border-black/10 p-4">
      <div className="text-xs uppercase tracking-widest font-bold text-black/40">{label}</div>
      <div className={`mt-2 text-sm font-semibold break-all ${mono ? "font-mono font-normal" : ""}`}>{value}</div>
    </div>
  );
}
