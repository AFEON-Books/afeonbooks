import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  Flag,
  Forward,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  MailOpen,
  Pencil,
  Printer,
  RefreshCw,
  Search,
  Send,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { authApiRequest, useAuth } from "../../../site/src/lib/auth";
import { Button } from "../components/ui/button";
import "./mailbox.css";

type ZohoFolder = { id: string; name: string; total?: number; unread?: number };
type MailView = "all" | "unread" | "flagged";
type ZohoMessage = {
  id: string;
  threadId?: string;
  subject: string;
  sender: string;
  senderAddress: string;
  recipients: string;
  preview: string;
  date: string;
  unread: boolean;
  flagged: boolean;
  raw: Record<string, unknown>;
};
type MailSession = { unlocked: boolean; emailAddress?: string; unlockedUntil?: string };
type ComposeState = { mode: "new" | "reply" | "forward"; to: string; subject: string; body: string };
type InlineImage = { contentType: string; data: string };

const MESSAGE_PAGE_SIZE = 100;
const MAX_INLINE_MESSAGE_IMAGES = 20;
const api = <T,>(path: string, options?: RequestInit) => authApiRequest<T>(path, options);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown, hints: string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(record);
  const object = record(value);
  for (const key of ["data", ...hints]) {
    const candidate = object[key];
    if (Array.isArray(candidate)) return candidate.map(record);
    const nested = record(candidate);
    for (const hint of hints) {
      if (Array.isArray(nested[hint])) return (nested[hint] as unknown[]).map(record);
    }
  }
  return [];
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function decodeHtmlEntities(value: string): string {
  return new DOMParser().parseFromString(value, "text/html").body.textContent ?? value;
}

function field(item: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (item[key] !== undefined && item[key] !== null) return item[key];
  return undefined;
}

function address(value: unknown): { name: string; email: string } {
  if (typeof value === "string") {
    const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    return match ? { name: match[1].replace(/^"|"$/g, ""), email: match[2] } : { name: value, email: value };
  }
  if (Array.isArray(value)) return address(value[0]);
  const item = record(value);
  const email = text(field(item, "emailAddress", "address", "email", "mailId"));
  return { name: text(field(item, "name", "displayName", "personalName")) || email, email };
}

function normalizeFolders(payload: unknown): ZohoFolder[] {
  return records(payload, ["folders", "folderDetails", "folderList"]).map((item) => ({
    id: text(field(item, "folderId", "folderid", "id")),
    name: text(field(item, "folderName", "foldername", "name", "displayName")) || "Folder",
    total: Number(field(item, "totalCount", "messageCount", "total") ?? 0) || 0,
    unread: Number(field(item, "unreadCount", "unread") ?? 0) || 0,
  })).filter((folder) => /^\d+$/.test(folder.id));
}

function normalizeMessages(payload: unknown): ZohoMessage[] {
  return records(payload, ["messages", "emailList", "emails", "messageList"]).map((item) => {
    const sender = address(field(item, "fromAddress", "sender", "from", "fromaddress"));
    const readValue = field(item, "isRead", "isread", "read");
    const isUnread = field(item, "isUnread", "unread");
    const unread = isUnread === true || isUnread === "true" || readValue === false || readValue === "false" || readValue === 0;
    const rawDate = field(item, "receivedTime", "sentDateInGMT", "receivedDate", "date", "sentTime");
    const dateNumber = Number(rawDate);
    const date = Number.isFinite(dateNumber) && dateNumber > 0
      ? new Date(dateNumber < 10_000_000_000 ? dateNumber * 1000 : dateNumber).toISOString()
      : text(rawDate);
    const subject = text(field(item, "subject", "Subject")) || "(no subject)";
    const preview = decodeHtmlEntities(text(field(item, "summary", "snippet", "preview", "content", "messageContent")));
    const rawFlag = text(field(item, "flagid", "flag", "flagType")).toLowerCase();
    return {
      id: text(field(item, "messageId", "messageid", "id")),
      threadId: text(field(item, "threadId", "threadid")) || undefined,
      subject,
      sender: sender.name || sender.email || "Unknown sender",
      senderAddress: sender.email,
      recipients: text(field(item, "toAddress", "toaddress", "to")),
      preview,
      date,
      unread,
      flagged: rawFlag !== "" && rawFlag !== "flag_not_set",
      raw: item,
    };
  }).filter((message) => /^\d+$/.test(message.id));
}

function messageContent(payload: unknown): string {
  const item = record(payload);
  const data = record(item.data);
  return text(field(item, "content", "messageContent", "htmlContent", "body") ?? field(data, "content", "messageContent", "htmlContent", "body"));
}

async function inlineMessageImages(content: string, folderId: string, messageId: string): Promise<{ content: string; failed: boolean }> {
  if (!/<\s*(html|body|div|p|table|a|img|br)\b/i.test(content)) return { content, failed: false };
  const document = new DOMParser().parseFromString(content, "text/html");
  const images = new Map<string, { images: HTMLImageElement[]; params: URLSearchParams }>();
  for (const image of Array.from(document.querySelectorAll<HTMLImageElement>("img[src]"))) {
    const source = image.getAttribute("src");
    if (!source) continue;
    let url: URL;
    try { url = new URL(source, window.location.origin); } catch { continue; }
    const trustedOrigin = url.origin === window.location.origin
      || (url.protocol === "https:" && /^mail\.zoho\.(?:com|eu|in|com\.au|com\.cn|jp)$/.test(url.hostname));
    const params = url.searchParams;
    const accountId = params.get("na") ?? "";
    const fileName = params.get("f") ?? "";
    const cid = params.get("cid") ?? "";
    if (!trustedOrigin || url.pathname !== "/mail/ImageDisplay"
      || params.get("nmsgId") !== messageId
      || !/^\d+$/.test(accountId)
      || params.get("mode") !== "inline"
      || !/^[A-Za-z0-9_-]{1,80}\.(?:png|jpe?g|gif|webp|avif)$/i.test(fileName)
      || !/^[A-Za-z0-9._@+-]{1,256}$/.test(cid)) continue;
    const key = `${fileName}\0${cid}`;
    const group = images.get(key);
    if (group) {
      group.images.push(image);
    } else {
      images.set(key, {
        images: [image],
        params: new URLSearchParams({ na: accountId, nmsgId: messageId, f: fileName, mode: "inline", cid }),
      });
    }
  }
  if (images.size === 0) return { content, failed: false };
  const requests = Array.from(images.values());
  let failed = requests.length > MAX_INLINE_MESSAGE_IMAGES;
  for (let index = 0; index < Math.min(requests.length, MAX_INLINE_MESSAGE_IMAGES); index += 4) {
    await Promise.all(requests.slice(index, index + 4).map(async ({ images: matchingImages, params }) => {
      const path = `/api/mail/messages/${encodeURIComponent(folderId)}/${encodeURIComponent(messageId)}/inline-image?${params}`;
      try {
        const result = await api<InlineImage>(path);
        for (const image of matchingImages) image.setAttribute("src", `data:${result.contentType};base64,${result.data}`);
      } catch {
        failed = true;
        for (const image of matchingImages) image.removeAttribute("src");
      }
    }));
  }
  return { content: `${document.head.innerHTML}${document.body.innerHTML}`, failed };
}

function safeMessageDocument(content: string): string {
  const isHtml = /<\s*(html|body|div|p|table|a|img|br)\b/i.test(content);
  const body = isHtml ? content : `<pre>${content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><meta name="referrer" content="no-referrer"><style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#202421;overflow-wrap:anywhere;margin:16px}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit}</style></head><body>${body}</body></html>`;
}

function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function escapedHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\n/g, "<br>");
}

function quotedMessage(content: string): string {
  const textContent = new DOMParser().parseFromString(content, "text/html").body.textContent?.trim() ?? "";
  return textContent ? `\n\n---------- Forwarded message ----------\n${textContent}` : "";
}

function SignInGate() {
  const returnTo = encodeURIComponent(window.location.href);
  return (
    <main className="mail-gate">
      <div className="mail-gate-mark"><Mail size={24} /></div>
      <p className="mail-eyebrow">AFEON / PRIVATE SYSTEM</p>
      <h1>Administrator sign-in required</h1>
      <p>Sign in to your AFEON admin account, then authorize your Zoho mailbox separately.</p>
      <Button onClick={() => window.location.assign(`https://authn.afeonbooks.com/account?return_to=${returnTo}`)}>
        <LockKeyhole /> Continue to sign in
      </Button>
    </main>
  );
}

export default function Mailbox() {
  const { user, loading: authLoading, signOut } = useAuth();
  const [session, setSession] = useState<MailSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [folders, setFolders] = useState<ZohoFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [mailView, setMailView] = useState<MailView>("all");
  const [messages, setMessages] = useState<ZohoMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<ZohoMessage | null>(null);
  const [content, setContent] = useState("");
  const messageFrameRef = useRef<HTMLIFrameElement>(null);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [pageStart, setPageStart] = useState(1);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const activeFolder = useMemo(() => folders.find((folder) => folder.id === folderId), [folders, folderId]);
  const visibleMessages = useMemo(() => messages.filter((message) => (
    mailView === "unread" ? message.unread : mailView === "flagged" ? message.flagged : true
  )), [mailView, messages]);
  const unreadTotal = activeFolder?.unread ?? 0;
  const allVisibleSelected = visibleMessages.length > 0 && visibleMessages.every((message) => selectedIds.has(message.id));
  const selectedHasUnread = visibleMessages.some((message) => selectedIds.has(message.id) && message.unread);

  useEffect(() => {
    document.title = "AFEON Mail";
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      window.location.replace(`https://authn.afeonbooks.com/account?return_to=${encodeURIComponent(window.location.href)}`);
      return;
    }
    if (user.role !== "admin") return;
    setCheckingSession(true);
    const params = new URLSearchParams(window.location.search);
    if (params.has("mail_connected") || params.has("mail_error")) {
      const mailError = params.get("mail_error");
      setNotice(params.has("mail_connected")
        ? "Zoho mailbox unlocked for this session."
        : mailError === "account_mismatch"
          ? "Error 403: Zoho Mail callback returned a mailbox that does not match the current user"
          : "Zoho sign-in did not complete. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    void api<MailSession>("/api/mail/session").then(setSession).catch((err) => {
      setError(err instanceof Error ? err.message : "Unable to verify mailbox session");
      setSession({ unlocked: false });
    }).finally(() => setCheckingSession(false));
  }, [authLoading, user]);

  useEffect(() => {
    if (!session?.unlocked || user?.role !== "admin") return;
    void api<unknown>("/api/mail/folders").then((payload) => {
      const nextFolders = normalizeFolders(payload);
      setFolders(nextFolders);
      setFolderId((current) => current && nextFolders.some((folder) => folder.id === current)
        ? current
        : nextFolders.find((folder) => /inbox/i.test(folder.name))?.id ?? nextFolders[0]?.id ?? "");
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load folders"));
  }, [session?.unlocked, user?.role]);

  useEffect(() => {
    if (!session?.unlocked || !folderId || user?.role !== "admin") return;
    setLoading(true);
    setError("");
    const endpoint = query
      ? `/api/mail/search?q=${encodeURIComponent(query)}&start=${pageStart}&limit=${MESSAGE_PAGE_SIZE}`
      : `/api/mail/messages?folderId=${encodeURIComponent(folderId)}&start=${pageStart}&limit=${MESSAGE_PAGE_SIZE}`;
    void api<unknown>(endpoint).then((payload) => {
      const nextMessages = normalizeMessages(payload);
      setMessages(nextMessages);
      setSelectedIds(new Set());
      setSelected((current) => current ? nextMessages.find((message) => message.id === current.id) ?? null : null);
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load messages")).finally(() => setLoading(false));
  }, [session?.unlocked, folderId, query, pageStart, refreshKey, user?.role]);

  useEffect(() => {
    if (!session?.unlocked || !selected || !folderId || user?.role !== "admin") {
      setContent("");
      return;
    }
    setContent("");
    let cancelled = false;
    void api<unknown>(`/api/mail/messages/${folderId}/${selected.id}`).then(async (payload) => {
      const result = await inlineMessageImages(messageContent(payload), folderId, selected.id);
      if (cancelled) return;
      setContent(result.content);
      if (result.failed) setError("Some inline images in this email could not be loaded.");
      if (selected.unread) {
        void api(`/api/mail/messages/${folderId}/${selected.id}/actions`, { method: "POST", body: JSON.stringify({ action: "read" }) })
          .then(() => setRefreshKey((key) => key + 1)).catch(() => undefined);
      }
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Unable to open message");
    });
    return () => { cancelled = true; };
  }, [session?.unlocked, selected?.id, folderId, user?.role]);

  const startZohoSignIn = () => window.location.assign("/api/mail/auth/start");

  const lockMailbox = async () => {
    setWorking(true);
    try {
      await api("/api/mail/lock", { method: "POST" });
      setSession({ unlocked: false });
      setFolders([]);
      setMessages([]);
      setSelected(null);
      setContent("");
      setNotice("Mailbox locked.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to lock mailbox");
    } finally {
      setWorking(false);
    }
  };

  const runAction = async (action: Record<string, string>) => {
    if (!selected || !folderId) return;
    setWorking(true);
    setError("");
    try {
      await api(`/api/mail/messages/${folderId}/${selected.id}/actions`, { method: "POST", body: JSON.stringify(action) });
      setSelected(null);
      setContent("");
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mailbox action failed");
    } finally {
      setWorking(false);
    }
  };

  const runBulkAction = async (action: Record<string, string>) => {
    const targets = visibleMessages.filter((message) => selectedIds.has(message.id));
    if (!targets.length || !folderId) return;
    setWorking(true);
    setError("");
    try {
      for (const message of targets) {
        await api(`/api/mail/messages/${folderId}/${message.id}/actions`, {
          method: "POST",
          body: JSON.stringify(action),
        });
      }
      if (selected && targets.some((message) => message.id === selected.id)) {
        setSelected(null);
        setContent("");
      }
      setSelectedIds(new Set());
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Some selected messages could not be updated.");
      setRefreshKey((key) => key + 1);
    } finally {
      setWorking(false);
    }
  };

  const toggleMessageSelection = (messageId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleMessages.map((message) => message.id)));
  };

  const openCompose = (mode: "new" | "reply" | "forward") => {
    if (mode === "reply" && selected) {
      const subject = selected.subject.toLowerCase().startsWith("re:") ? selected.subject : `Re: ${selected.subject}`;
      setCompose({ mode, to: selected.senderAddress, subject, body: "" });
      return;
    }
    if (mode === "forward" && selected) {
      const subject = selected.subject.toLowerCase().startsWith("fwd:") ? selected.subject : `Fwd: ${selected.subject}`;
      setCompose({ mode, to: "", subject, body: quotedMessage(content) });
      return;
    }
    setCompose({ mode: "new", to: "", subject: "", body: "" });
  };

  const submitCompose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!compose || !selected && compose.mode === "reply") return;
    const formData = new FormData(event.currentTarget);
    const to = String(formData.get("to") ?? "").split(/[;,\s]+/).filter(Boolean);
    const cc = String(formData.get("cc") ?? "").split(/[;,\s]+/).filter(Boolean);
    const subject = String(formData.get("subject") ?? "").trim();
    const body = String(formData.get("body") ?? "");
    if (!to.length || !subject || !body.trim()) {
      setError("Add a recipient, subject, and message.");
      return;
    }
    setWorking(true);
    setError("");
    try {
      const payload = { to, ...(cc.length ? { cc } : {}), subject, html: `<div style="font:14px/1.6 Arial,sans-serif">${escapedHtml(body)}</div>` };
      if (compose.mode === "reply" && selected) {
        await api(`/api/mail/messages/${folderId}/${selected.id}/reply`, { method: "POST", body: JSON.stringify(payload) });
      } else {
        await api("/api/mail/messages", { method: "POST", body: JSON.stringify(payload) });
      }
      setCompose(null);
      setNotice("Message sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send message");
    } finally {
      setWorking(false);
    }
  };

  if (authLoading || user?.role === "admin" && checkingSession) {
    return <main className="mail-gate"><LoaderCircle className="animate-spin" /><p>Securing mailbox session...</p></main>;
  }
  if (!user) return <SignInGate />;
  if (user.role !== "admin") {
    return (
      <main className="mail-gate">
        <div className="mail-gate-mark"><LockKeyhole size={24} /></div>
        <p className="mail-eyebrow">RESTRICTED ACCESS</p>
        <h1>Administrator access only</h1>
        <p>This mailbox is available only to AFEON administrators.</p>
        <Button onClick={async () => { await signOut(); window.location.assign("https://authn.afeonbooks.com/account"); }}><LogOut /> Sign out</Button>
      </main>
    );
  }

  if (!session?.unlocked) {
    return (
      <main className="mail-gate">
        <div className="mail-gate-mark"><LockKeyhole size={24} /></div>
        <p className="mail-eyebrow">AFEON / MAIL SYSTEM</p>
        <h1>Unlock your mailbox</h1>
        <p>Signed in as <strong>{user.email}</strong>. Sign in to Zoho separately to open mail. Access locks automatically after 30 minutes or when you lock it.</p>
        {error && <p className="mail-error">{error}</p>}
        {notice && <p className="mail-notice">{notice}</p>}
        <Button onClick={startZohoSignIn}><LockKeyhole /> Sign in to Zoho Mail</Button>
        <button className="mail-text-button" onClick={async () => { await signOut(); window.location.assign("https://authn.afeonbooks.com/account"); }}>Sign out of AFEON</button>
      </main>
    );
  }

  return (
    <main className="mail-app">
      <header className="mail-topbar">
        <a className="mail-brand" href="/"><span className="mail-brand-icon"><Mail size={19} /></span><span>AFEON <b>MAIL</b></span></a>
        <form className="mail-search" onSubmit={(event) => { event.preventDefault(); setQuery(searchText.trim()); setPageStart(1); setSelected(null); }}>
          <Search size={16} aria-hidden="true" />
          <input aria-label="Search mail" placeholder="Search all mail" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
          {query && <button type="button" title="Clear search" onClick={() => { setSearchText(""); setQuery(""); setPageStart(1); }}><span className="sr-only">Clear search</span>×</button>}
        </form>
        <div className="mail-account">
          <span className="mail-account-address">{session.emailAddress}</span>
          <button title="Lock Zoho mailbox" aria-label="Lock Zoho mailbox" onClick={() => void lockMailbox()} disabled={working}><LockKeyhole size={17} /></button>
          <button title="Sign out of AFEON" aria-label="Sign out of AFEON" onClick={async () => { await signOut(); window.location.assign("https://authn.afeonbooks.com/account"); }}><LogOut size={17} /></button>
        </div>
      </header>

      <div className={`mail-workspace ${selected ? "has-selection" : ""}`}>
        <aside className="mail-sidebar">
          <Button className="mail-compose-button" onClick={() => openCompose("new")}><Pencil size={16} /> New Mail</Button>
          <nav aria-label="Mail folders" className="mail-folder-list">
            {folders.map((folder) => {
              const isSelected = folder.id === folderId;
              const FolderIcon = /inbox/i.test(folder.name) ? Inbox : /sent/i.test(folder.name) ? Send : /draft/i.test(folder.name) ? FileText : /trash|deleted/i.test(folder.name) ? Trash2 : /archive/i.test(folder.name) ? Archive : Mail;
              return <button key={folder.id} className={`mail-folder ${isSelected && mailView === "all" ? "is-selected" : ""}`} onClick={() => { setFolderId(folder.id); setMailView("all"); setQuery(""); setSearchText(""); setPageStart(1); setSelected(null); setSelectedIds(new Set()); }}><FolderIcon size={17} /><span>{folder.name}</span>{folder.unread ? <b>{folder.unread}</b> : null}</button>;
            })}
            <div className="mail-nav-divider" />
            <p className="mail-nav-label">VIEWS</p>
            <button className={`mail-folder mail-view ${mailView === "unread" ? "is-selected" : ""}`} onClick={() => { setMailView("unread"); setSelected(null); setSelectedIds(new Set()); }}><MailOpen size={17} /><span>Unread</span>{unreadTotal > 0 && <b>{unreadTotal}</b>}</button>
            <button className={`mail-folder mail-view ${mailView === "all" ? "is-selected" : ""}`} onClick={() => { setMailView("all"); setSelected(null); setSelectedIds(new Set()); }}><Mail size={17} /><span>All messages</span></button>
            <button className={`mail-folder mail-view ${mailView === "flagged" ? "is-selected" : ""}`} onClick={() => { setMailView("flagged"); setSelected(null); setSelectedIds(new Set()); }}><Flag size={17} /><span>Flagged</span></button>
          </nav>
          <div className="mail-sidebar-foot"><span className="mail-secure-dot" /> Session expires at {session.unlockedUntil ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(session.unlockedUntil)) : "30 min"}</div>
        </aside>

        <section className={`mail-list-pane ${selected ? "has-selection" : ""}`} aria-label="Messages">
          <div className="mail-list-heading">
            <div><p className="mail-eyebrow">{query ? "SEARCH RESULTS" : mailView === "all" ? "MAILBOX" : "VIEWS"}</p><h1>{query ? `Results for “${query}”` : mailView === "unread" ? "Unread" : mailView === "flagged" ? "Flagged" : activeFolder?.name ?? "Messages"}</h1></div>
            <button title="Refresh messages" aria-label="Refresh messages" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}><RefreshCw size={17} className={loading ? "animate-spin" : ""} /></button>
          </div>
          <div className="mail-list-toolbar">
            <label className="mail-select-all" title="Select all messages">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} disabled={!visibleMessages.length || working} />
              <span className="sr-only">Select all messages</span>
            </label>
            {selectedIds.size > 0 ? <>
              <span className="mail-selection-count">{selectedIds.size} selected</span>
              <button title={selectedHasUnread ? "Mark selected as read" : "Mark selected as unread"} aria-label={selectedHasUnread ? "Mark selected as read" : "Mark selected as unread"} onClick={() => void runBulkAction({ action: selectedHasUnread ? "read" : "unread" })} disabled={working}><MailOpen size={16} /><span>{selectedHasUnread ? "Read" : "Unread"}</span></button>
              <select aria-label="Move selected messages to folder" value="" onChange={(event) => { if (event.target.value) void runBulkAction({ action: "move", destinationFolderId: event.target.value }); }} disabled={working}>
                <option value="">Move to…</option>{folders.filter((folder) => folder.id !== folderId).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
              <button title="Flag selected" aria-label="Flag selected messages" onClick={() => void runBulkAction({ action: "flag", flag: "important" })} disabled={working}><Flag size={16} /><span>Flag</span></button>
              <button title="Archive selected" aria-label="Archive selected messages" onClick={() => void runBulkAction({ action: "archive" })} disabled={working}><Archive size={16} /><span>Archive</span></button>
              <button title="Move selected to Trash" aria-label="Delete selected messages" onClick={() => void runBulkAction({ action: "delete" })} disabled={working}><Trash2 size={16} /><span>Trash</span></button>
            </> : <>
              <span className="mail-toolbar-caption">{mailView === "unread" ? `${unreadTotal} unread in ${activeFolder?.name ?? "folder"}` : mailView === "flagged" ? "Flagged messages in folder" : "Views"}</span>
              <button title="Filter unread messages" aria-label="Show unread messages" onClick={() => setMailView("unread")}><MailOpen size={16} /><span>Unread</span></button>
              <button title="Show flagged messages" aria-label="Show flagged messages" onClick={() => setMailView("flagged")}><Flag size={16} /><span>Flagged</span></button>
            </>}
          </div>
          {error && <div className="mail-inline-error"><CircleAlert size={16} /> {error}</div>}
          {notice && <div className="mail-inline-notice">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
          {loading && messages.length === 0 ? <div className="mail-empty"><LoaderCircle className="animate-spin" /> Loading messages</div> : null}
          {!loading && visibleMessages.length === 0 ? <div className="mail-empty"><MailOpen size={28} /><p>{query ? "No matching messages" : mailView === "unread" ? "No unread messages in this folder" : mailView === "flagged" ? "No flagged messages in this folder" : "This folder is empty"}</p></div> : null}
          <div className="mail-message-list">
            {visibleMessages.map((message) => (
              <div key={message.id} className={`mail-message-row ${selected?.id === message.id ? "is-active" : ""} ${message.unread ? "is-unread" : ""} ${selectedIds.has(message.id) ? "is-checked" : ""}`}>
                <input aria-label={`Select ${message.subject}`} type="checkbox" checked={selectedIds.has(message.id)} onChange={() => toggleMessageSelection(message.id)} disabled={working} />
                <button className="mail-message-main" onClick={() => setSelected(message)}>
                  <span className="mail-message-sender">{message.sender}</span>
                  <span className="mail-message-date">{displayDate(message.date)}</span>
                  <span className="mail-message-subject">{message.subject}</span>
                  <span className="mail-message-preview">{message.preview || message.recipients || "Open message"}</span>
                </button>
                {message.flagged && <Flag className="mail-message-flag" size={14} fill="currentColor" />}
              </div>
            ))}
          </div>
          {messages.length > 0 && <div className="mail-pagination"><button disabled={pageStart <= 1} onClick={() => setPageStart((value) => Math.max(1, value - MESSAGE_PAGE_SIZE))} aria-label="Newer messages"><ChevronLeft size={17} /></button><span>{pageStart}–{pageStart + messages.length - 1}</span><button disabled={messages.length < MESSAGE_PAGE_SIZE} onClick={() => setPageStart((value) => value + MESSAGE_PAGE_SIZE)} aria-label="Older messages"><ChevronRight size={17} /></button></div>}
        </section>

        <section className={`mail-reading-pane ${selected ? "has-selection" : ""}`} aria-label="Message preview">
          {selected ? <>
            <div className="mail-reading-toolbar">
              <button className="mail-mobile-back" onClick={() => setSelected(null)} title="Back to messages"><ArrowLeft size={17} /></button>
              <button title="Reply" aria-label="Reply" onClick={() => openCompose("reply")}><ArrowLeftRight size={17} /></button>
              <button title={selected.unread ? "Mark as read" : "Mark as unread"} aria-label={selected.unread ? "Mark as read" : "Mark as unread"} onClick={() => void runAction({ action: selected.unread ? "read" : "unread" })}><MailOpen size={17} /></button>
              <button title="Archive" aria-label="Archive" onClick={() => void runAction({ action: "archive" })}><Archive size={17} /></button>
              <button title={selected.flagged ? "Clear flag" : "Flag important"} aria-label={selected.flagged ? "Clear flag" : "Flag important"} onClick={() => void runAction({ action: "flag", flag: selected.flagged ? "flag_not_set" : "important" })}><Star size={17} fill={selected.flagged ? "currentColor" : "none"} /></button>
              <button title="Forward" aria-label="Forward message" onClick={() => openCompose("forward")}><Forward size={17} /></button>
              <button title="Print message" aria-label="Print message" onClick={() => messageFrameRef.current?.contentWindow?.print()}><Printer size={17} /></button>
              <select aria-label="Move message to folder" value="" onChange={(event) => { if (event.target.value) void runAction({ action: "move", destinationFolderId: event.target.value }); }}><option value="">Move to…</option>{folders.filter((folder) => folder.id !== folderId).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
              <button className="mail-delete-action" title="Move to Trash" aria-label="Move to Trash" onClick={() => void runAction({ action: "delete" })}><Trash2 size={17} /></button>
              <button title="Close message" aria-label="Close message" onClick={() => setSelected(null)}><X size={17} /></button>
            </div>
            <article className="mail-reading-content">
              <div className="mail-subject-line"><h2>{selected.subject}</h2><span>{displayDate(selected.date)}</span></div>
              <div className="mail-sender-details"><div className="mail-sender-avatar">{(selected.sender[0] || "?").toUpperCase()}</div><div><strong>{selected.sender}</strong><p>{selected.senderAddress}</p></div></div>
              <div className="mail-recipient-line">To {selected.recipients || session.emailAddress}</div>
              {content ? <iframe ref={messageFrameRef} className="mail-message-frame" title={`Message: ${selected.subject}`} sandbox="allow-modals" referrerPolicy="no-referrer" srcDoc={safeMessageDocument(content)} /> : <div className="mail-body-loading"><LoaderCircle className="animate-spin" /> Loading message content</div>}
            </article>
          </> : <div className="mail-reading-empty"><Mail size={28} /><p>Select a message to read</p></div>}
        </section>
      </div>

      {compose && <div className="mail-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) setCompose(null); }}>
        <form className="mail-compose-modal" onSubmit={submitCompose}>
          <div className="mail-compose-head"><h2>{compose.mode === "reply" ? "Reply" : compose.mode === "forward" ? "Forward message" : "New message"}</h2><button type="button" title="Close" aria-label="Close compose" onClick={() => setCompose(null)}>×</button></div>
          <label>To<input name="to" type="text" defaultValue={compose.to} placeholder="example@afeonbooks.com" autoComplete="off" required /></label>
          <label>Cc<input name="cc" type="text" placeholder="Optional recipients" autoComplete="off" /></label>
          <label>Subject<input name="subject" type="text" defaultValue={compose.subject} maxLength={998} required /></label>
          <label className="mail-compose-body-label">Message<textarea name="body" placeholder="Write your message" defaultValue={compose.body} required /></label>
          {error && <p className="mail-error">{error}</p>}
          <div className="mail-compose-actions"><Button type="submit" disabled={working}><Send size={16} /> {working ? "Sending…" : "Send"}</Button><button type="button" onClick={() => setCompose(null)} disabled={working}>Discard</button></div>
        </form>
      </div>}
    </main>
  );
}