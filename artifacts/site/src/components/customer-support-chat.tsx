import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageCircle, Send, X } from "lucide-react";

const API_BASE = "/api";
const REFRESH_INTERVAL_MS = 3_000;

interface SupportMessage {
  id: number;
  senderType: "customer" | "staff";
  message: string;
  createdAt: string;
}

interface SupportMessagesResponse {
  conversationId: number;
  status: "open" | "closed";
  messages: SupportMessage[];
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export function CustomerSupportChat() {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [error, setError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef(false);
  const sessionStartingRef = useRef(false);

  useEffect(() => {
    if (!open || conversationId !== null || sessionStartingRef.current) return;
    sessionStartingRef.current = true;
    setLoading(true);
    setError("");
    void fetch(`${API_BASE}/support-chat/session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response, "Unable to open customer support."));
        const session = await response.json() as { conversationId: number };
        setConversationId(session.conversationId);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unable to open customer support.");
      })
      .finally(() => {
        sessionStartingRef.current = false;
        setLoading(false);
      });
  }, [open, conversationId]);

  useEffect(() => {
    if (!open || conversationId === null) return;
    const controller = new AbortController();
    const loadMessages = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const response = await fetch(`${API_BASE}/support-chat/messages`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await readError(response, "Unable to load your support messages."));
        const result = await response.json() as SupportMessagesResponse;
        if (!controller.signal.aborted) {
          setMessages(result.messages);
          setStatus(result.status);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Unable to load your support messages.");
        }
      } finally {
        pollingRef.current = false;
      }
    };
    void loadMessages();
    const interval = window.setInterval(() => void loadMessages(), REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [open, conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending || conversationId === null || status === "closed") return;
    setSending(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/support-chat/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to send your message."));
      const saved = await response.json() as SupportMessage;
      setMessages((current) => current.some((item) => item.id === saved.id) ? current : [...current, saved]);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send your message.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-5 right-5 z-[110] font-sans">
      {open && (
        <section
          aria-label="Customer support chat"
          className="mb-3 flex h-[min(34rem,calc(100dvh-7rem))] w-[min(23rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl"
        >
          <header className="flex items-center justify-between bg-[#80d7f6] px-4 py-3 text-[#111111]">
            <div>
              <h2 className="text-sm font-semibold">AFEON Books Support</h2>
              <p className="text-xs text-black/70">Send us a message and we’ll reply here.</p>
            </div>
            <button type="button" aria-label="Close support chat" onClick={() => setOpen(false)} className="rounded-full p-1 hover:bg-black/10">
              <X size={18} />
            </button>
          </header>
          <div className="flex-1 space-y-3 overflow-y-auto bg-[#faf9f6] p-3">
            {loading && <p className="py-8 text-center text-sm text-stone-500">Opening support…</p>}
            {!loading && messages.length === 0 && (
              <p className="py-8 text-center text-sm text-stone-500">How can we help?</p>
            )}
            {messages.map((message) => {
              const fromCustomer = message.senderType === "customer";
              return (
                <div key={message.id} className={`flex ${fromCustomer ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${fromCustomer ? "rounded-br-sm bg-[#80d7f6] text-[#111111]" : "rounded-bl-sm bg-white text-stone-800 shadow-sm"}`}>
                    {!fromCustomer && <p className="mb-1 text-[10px] font-semibold text-stone-500">AFEON Books Support</p>}
                    <p className="whitespace-pre-wrap break-words text-sm">{message.message}</p>
                    <time className="mt-1 block text-right text-[10px] text-black/55">
                      {new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </time>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
          {status === "closed" ? (
            <div className="border-t border-stone-100 bg-stone-50 px-3 py-3 text-center text-xs font-medium text-stone-600">
              This support session has ended.
            </div>
          ) : (
          <form onSubmit={sendMessage} className="flex items-end gap-2 border-t border-stone-100 p-3">
            <textarea
              aria-label="Write a support message"
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, 2000))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Write a message…"
              rows={1}
              maxLength={2000}
              className="max-h-24 min-h-10 flex-1 resize-none rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-[#80d7f6]"
            />
            <button
              type="submit"
              disabled={!draft.trim() || sending || conversationId === null}
              aria-label="Send support message"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#80d7f6] text-[#111111] hover:bg-[#6ac9eb] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={17} />
            </button>
          </form>
          )}
          {error && <p role="alert" className="border-t border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        </section>
      )}
      <button
        type="button"
        aria-label={open ? "Close customer support chat" : "Open customer support chat"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ml-auto flex h-14 items-center gap-2 rounded-full bg-[#80d7f6] px-5 text-sm font-semibold text-[#111111] shadow-lg transition hover:bg-[#6ac9eb]"
      >
        {open ? <X size={20} /> : <MessageCircle size={20} />}
        <span>{open ? "Close" : "Support"}</span>
      </button>
    </div>
  );
}
