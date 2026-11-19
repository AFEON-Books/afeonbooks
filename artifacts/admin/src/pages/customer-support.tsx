import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, MessageCircle, Send } from "lucide-react";

const REFRESH_INTERVAL_MS = 4_000;

interface SupportConversation {
  id: number;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  unread: boolean;
}

interface SupportMessage {
  id: number;
  senderType: "customer" | "staff";
  senderUserId: number | null;
  senderName?: string | null;
  message: string;
  createdAt: string;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export default function CustomerSupportPage() {
  const [conversations, setConversations] = useState<SupportConversation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const listRequestRef = useRef(false);
  const messageRequestRef = useRef(false);

  const loadConversations = useCallback(async () => {
    if (listRequestRef.current) return;
    listRequestRef.current = true;
    try {
      const response = await fetch("/api/support-chat/admin/conversations", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to load support conversations."));
      const result = await response.json() as { conversations: SupportConversation[] };
      setConversations(result.conversations);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load support conversations.");
    } finally {
      listRequestRef.current = false;
      setLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: number, signal?: AbortSignal) => {
    if (messageRequestRef.current) return;
    messageRequestRef.current = true;
    try {
      const response = await fetch(`/api/support-chat/admin/conversations/${conversationId}/messages`, {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to load this conversation."));
      const result = await response.json() as { conversation: { status: "open" | "closed" }; messages: SupportMessage[] };
      if (!signal?.aborted) {
        setMessages(result.messages);
        setStatus(result.conversation.status);
        setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, unread: false } : item));
        setError("");
      }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Unable to load this conversation.");
    } finally {
      messageRequestRef.current = false;
    }
  }, []);

  useEffect(() => {
    void loadConversations();
    const interval = window.setInterval(() => void loadConversations(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadConversations]);

  useEffect(() => {
    if (selectedId === null) {
      setMessages([]);
      return;
    }
    const controller = new AbortController();
    void loadMessages(selectedId, controller.signal);
    const interval = window.setInterval(() => void loadMessages(selectedId, controller.signal), REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [selectedId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending || selectedId === null || status === "closed") return;
    setSending(true);
    setError("");
    try {
      const response = await fetch(`/api/support-chat/admin/conversations/${selectedId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to send your reply."));
      const saved = await response.json() as SupportMessage;
      setMessages((current) => current.some((item) => item.id === saved.id) ? current : [...current, saved]);
      setDraft("");
      void loadConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send your reply.");
    } finally {
      setSending(false);
    }
  };

  const updateStatus = async () => {
    if (selectedId === null || closing) return;
    const nextStatus = status === "open" ? "closed" : "open";
    if (nextStatus === "closed") setClosing(true);
    try {
      const response = await fetch(`/api/support-chat/admin/conversations/${selectedId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to update this conversation."));
      const result = await response.json() as {
        conversation: { status: "open" | "closed" };
      };
      if (result.conversation.status === "closed") {
        setConversations((current) => current.filter((item) => item.id !== selectedId));
        setSelectedId(null);
        setMessages([]);
        setStatus("closed");
      } else {
        setStatus("open");
      }
      void loadConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update this conversation.");
    } finally {
      setClosing(false);
    }
  };

  const selectedConversation = conversations.find((item) => item.id === selectedId);

  return (
    <main className="flex h-dvh flex-col bg-[#f7f8fa] font-sans text-[#1d1c1d]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-black/10 bg-white px-4 sm:px-6">
        <a href="/" className="text-sm font-bold text-black/60 hover:text-black">Admin Hub</a>
        <span className="text-black/25">/</span>
        <h1 className="text-sm font-bold">Customer Support</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className={`${selectedId === null ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-black/10 bg-white sm:flex sm:w-80`}>
          <div className="border-b border-black/10 px-4 py-4">
            <h2 className="font-bold">Inbox</h2>
            <p className="mt-1 text-xs text-black/50">Customer conversations</p>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loading && <p className="px-3 py-6 text-sm text-black/50">Loading conversations…</p>}
            {!loading && conversations.length === 0 && (
              <p className="px-3 py-6 text-sm text-black/50">No customer messages yet.</p>
            )}
            {conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                onClick={() => { setSelectedId(conversation.id); setError(""); }}
                className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-[#f4f4f4] ${selectedId === conversation.id ? "bg-[#f0f0f0]" : ""}`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#80d7f6]/25 text-sm font-bold text-[#236078]">
                  <MessageCircle size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">Customer #{conversation.id}</span>
                    <span className="shrink-0 text-[10px] text-black/40">{new Date(conversation.updatedAt).toLocaleDateString()}</span>
                  </span>
                  <span className="mt-1 block text-xs text-black/50">{conversation.status === "open" ? "Open conversation" : "Closed conversation"}</span>
                </span>
                {conversation.unread && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#236078]" aria-label="Unread customer message" />}
              </button>
            ))}
          </div>
        </aside>
        <section className={`${selectedId === null ? "hidden" : "flex"} min-w-0 flex-1 flex-col sm:flex`}>
          {selectedConversation ? (
            <>
              <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-black/10 bg-white px-4 sm:px-6">
                <div className="flex min-w-0 items-center gap-2">
                  <button type="button" className="rounded p-1 hover:bg-black/5 sm:hidden" onClick={() => setSelectedId(null)} aria-label="Back to support inbox">
                    <ArrowLeft size={18} />
                  </button>
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-bold">Customer #{selectedId}</h2>
                    <p className="text-xs text-black/50">{status === "open" ? "Open conversation" : "Closed conversation"}</p>
                  </div>
                </div>
                <button type="button" onClick={() => void updateStatus()} disabled={closing} className="inline-flex items-center gap-2 rounded-md border border-black/15 px-3 py-2 text-xs font-semibold hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50">
                  <Check size={15} />
                  {closing ? "Ending session…" : status === "open" ? "Close conversation" : "Reopen"}
                </button>
              </header>
              <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-6">
                {messages.map((message) => {
                  const fromStaff = message.senderType === "staff";
                  return (
                    <div key={message.id} className={`flex ${fromStaff ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[min(85%,42rem)] rounded-2xl px-4 py-3 ${fromStaff ? "bg-[#80d7f6] text-[#111111]" : "bg-white shadow-sm"}`}>
                        <p className="mb-1 text-[10px] font-semibold opacity-60">{fromStaff ? message.senderName || "AFEON Books" : "Customer"}</p>
                        <p className="whitespace-pre-wrap break-words text-sm">{message.message}</p>
                        <time className="mt-2 block text-right text-[10px] opacity-55">
                          {new Date(message.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                        </time>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              <form onSubmit={sendMessage} className="flex shrink-0 items-end gap-2 border-t border-black/10 bg-white p-3 sm:p-4">
                <textarea
                  aria-label="Write a customer support reply"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value.slice(0, 2000))}
                  disabled={status === "closed"}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Reply to customer…"
                  rows={1}
                  maxLength={2000}
                  className="max-h-28 min-h-11 flex-1 resize-none rounded-lg border border-black/15 px-3 py-2 text-sm outline-none focus:border-[#80d7f6]"
                />
                <button type="submit" disabled={!draft.trim() || sending || status === "closed"} aria-label="Send reply" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#80d7f6] text-[#111111] hover:bg-[#6ac9eb] disabled:opacity-40">
                  <Send size={17} />
                </button>
              </form>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-black/45">Select a conversation to reply.</div>
          )}
          {error && <p role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</p>}
        </section>
      </div>
    </main>
  );
}
