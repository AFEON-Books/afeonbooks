import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, MessageCircle, Send, X } from "lucide-react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const PRESENCE_INTERVAL_MS = 20_000;

interface ChatUser {
  id: number;
  name: string;
}

interface ChatMessage {
  id: number;
  senderUserId: number;
  recipientUserId: number;
  message: string;
  createdAt: string;
}

interface ChatEvent {
  type: string;
  userId?: number;
  users?: ChatUser[];
  messages?: ChatMessage[];
  message?: ChatMessage;
  error?: string;
}

interface ChatSession {
  userId: number;
}

function getChatSocketUrl(): string {
  const apiOrigin = new URL(API_BASE, window.location.href).origin;
  const socketOrigin = import.meta.env.PROD && apiOrigin === window.location.origin
    ? "https://api-usw-2.afeonbooks.com"
    : apiOrigin;
  const url = new URL("/api/chat/socket", socketOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function sendEvent(socket: WebSocket | null, event: object): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(event));
  return true;
}

export function ChatWidget() {
  const [authorized, setAuthorized] = useState(false);
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [selectedUser, setSelectedUser] = useState<ChatUser | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unreadUsers, setUnreadUsers] = useState<Set<number>>(() => new Set());
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const selectedUserRef = useRef<ChatUser | null>(null);
  const currentUserIdRef = useRef<number | null>(null);
  const openRef = useRef(open);

  selectedUserRef.current = selectedUser;
  currentUserIdRef.current = currentUserId;
  openRef.current = open;

  const send = useCallback((event: object) => sendEvent(socketRef.current, event), []);

  useEffect(() => {
    let active = true;
    let retryTimeout: number | undefined;
    let retryCount = 0;
    let sessionUserId: number | null = null;

    const connect = async () => {
      try {
        if (sessionUserId === null) {
          const response = await fetch(`${API_BASE}/chat/session`, { credentials: "include" });
          if (response.status === 401 || response.status === 403) {
            if (active) setAuthorized(false);
            return;
          }
          if (!response.ok) throw new Error(`Unable to connect to chat (${response.status})`);
          const session = await response.json() as ChatSession;
          sessionUserId = session.userId;
          if (active) {
            setCurrentUserId(session.userId);
            setAuthorized(true);
          }
        }
        if (!active) return;

        const socket = new WebSocket(getChatSocketUrl());
        socketRef.current = socket;
        socket.onopen = () => {
          retryCount = 0;
          setConnected(true);
          setError("");
          sendEvent(socket, { type: "presence" });
        };
        socket.onmessage = (event: MessageEvent<string>) => {
          let data: ChatEvent;
          try {
            data = JSON.parse(event.data) as ChatEvent;
          } catch {
            setError("Received an invalid chat response");
            return;
          }

          if (data.type === "ready" && typeof data.userId === "number") {
            setCurrentUserId(data.userId);
          } else if (data.type === "users" && Array.isArray(data.users)) {
            setUsers(data.users);
          } else if (data.type === "history" && data.userId === selectedUserRef.current?.id && Array.isArray(data.messages)) {
            setMessages(data.messages);
            setUnreadUsers((current) => {
              const next = new Set(current);
              next.delete(data.userId!);
              return next;
            });
          } else if (data.type === "message" && data.message) {
            const peerId = data.message.senderUserId === currentUserIdRef.current
              ? data.message.recipientUserId
              : data.message.senderUserId;
            if (data.message.senderUserId === currentUserIdRef.current) {
              setSending(false);
              if (selectedUserRef.current?.id === data.message.recipientUserId) {
                setDraft((current) => current === data.message!.message ? "" : current);
              }
            }
            if (selectedUserRef.current?.id === peerId && openRef.current) {
              setMessages((current) => current.some((message) => message.id === data.message!.id)
                ? current
                : [...current, data.message!]);
            } else if (data.message.senderUserId !== currentUserIdRef.current) {
              setUnreadUsers((current) => new Set(current).add(peerId));
            }
          } else if (data.type === "error" && data.error) {
            setError(data.error);
            setSending(false);
          }
        };
        socket.onclose = (event) => {
          setConnected(false);
          setSending(false);
          if (socketRef.current === socket) socketRef.current = null;
          if (!active || event.code === 1008) {
            if (event.code === 1008) setAuthorized(false);
            return;
          }
          retryCount += 1;
          const delay = Math.min(1_000 * 2 ** Math.min(retryCount, 5), 30_000);
          retryTimeout = window.setTimeout(() => void connect(), delay);
        };
        socket.onerror = () => setError("Chat connection interrupted. Reconnecting…");
      } catch (requestError) {
        if (!active) return;
        setError(requestError instanceof Error ? requestError.message : "Unable to connect to chat");
        retryCount += 1;
        const delay = Math.min(1_000 * 2 ** Math.min(retryCount, 5), 30_000);
        retryTimeout = window.setTimeout(() => void connect(), delay);
      }
    };

    void connect();
    return () => {
      active = false;
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!authorized || !connected) return;
    const interval = window.setInterval(() => send({ type: "presence" }), PRESENCE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [authorized, connected, send]);

  useEffect(() => {
    if (!authorized || !connected || !open || !selectedUser) return;
    send({ type: "history", userId: selectedUser.id });
  }, [authorized, connected, open, selectedUser, send]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const selectUser = (user: ChatUser) => {
    setSelectedUser(user);
    setMessages([]);
    setError("");
    setUnreadUsers((current) => {
      const next = new Set(current);
      next.delete(user.id);
      return next;
    });
  };

  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!selectedUser || !message || sending) return;

    setSending(true);
    setError("");
    if (!send({ type: "send", recipientUserId: selectedUser.id, message })) {
      setSending(false);
      setError("Chat is reconnecting. Please try again.");
      return;
    }
  };

  if (!authorized) return null;

  return (
    <div className="fixed bottom-5 right-5 z-[100] font-sans">
      {open && (
        <section
          aria-label="Team chat"
          className="mb-3 flex h-[min(34rem,calc(100dvh-7rem))] w-[min(23rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl"
        >
          <header className="flex items-center justify-between bg-[#203b2c] px-4 py-3 text-white">
            <div className="flex min-w-0 items-center gap-2">
              {selectedUser && (
                <button
                  type="button"
                  aria-label="Back to online staff"
                  onClick={() => {
                    setSelectedUser(null);
                    setMessages([]);
                    setError("");
                  }}
                  className="rounded-full p-1 hover:bg-white/10"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">
                  {selectedUser?.name ?? "Team chat"}
                </h2>
                <p className="text-xs text-white/70">
                  {selectedUser
                    ? connected ? "Online now" : "Reconnecting…"
                    : `${users.length} staff online${connected ? " · Live" : " · Reconnecting…"}`}
                </p>
              </div>
            </div>
            <button type="button" aria-label="Close chat" onClick={() => setOpen(false)} className="rounded-full p-1 hover:bg-white/10">
              <X size={18} />
            </button>
          </header>

          {!selectedUser ? (
            <div className="flex-1 overflow-y-auto p-3">
              {users.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-stone-500">No other staff are online right now.</p>
              ) : (
                <ul className="space-y-1">
                  {users.map((user) => (
                    <li key={user.id}>
                      <button
                        type="button"
                        onClick={() => selectUser(user)}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-stone-50"
                      >
                        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf1eb] font-semibold text-[#203b2c]">
                          {user.name.slice(0, 1).toUpperCase()}
                          <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-green-500" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800">{user.name}</span>
                        {unreadUsers.has(user.id) && <span className="h-2.5 w-2.5 rounded-full bg-amber-600" aria-label="Unread message" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div className="flex-1 space-y-3 overflow-y-auto bg-[#faf9f6] p-3">
                {messages.length === 0 && (
                  <p className="py-8 text-center text-sm text-stone-500">Start a conversation with {selectedUser.name}.</p>
                )}
                {messages.map((message) => {
                  const mine = message.senderUserId === currentUserId;
                  return (
                    <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${mine ? "rounded-br-sm bg-[#203b2c] text-white" : "rounded-bl-sm bg-white text-stone-800 shadow-sm"}`}>
                        <p className="whitespace-pre-wrap break-words text-sm">{message.message}</p>
                        <time className={`mt-1 block text-right text-[10px] ${mine ? "text-white/60" : "text-stone-400"}`}>
                          {new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </time>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              <form onSubmit={sendMessage} className="flex items-end gap-2 border-t border-stone-100 p-3">
                <textarea
                  aria-label="Write a message"
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
                  className="max-h-24 min-h-10 flex-1 resize-none rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-[#597a62]"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || sending || !connected}
                  aria-label="Send message"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#203b2c] text-white hover:bg-[#31553f] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send size={17} />
                </button>
              </form>
            </>
          )}
          {error && <p role="alert" className="border-t border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        </section>
      )}
      <button
        type="button"
        aria-label={open ? "Close team chat" : "Open team chat"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ml-auto flex h-14 items-center gap-2 rounded-full bg-[#203b2c] px-5 text-sm font-semibold text-white shadow-lg transition hover:bg-[#31553f]"
      >
        {open ? <X size={20} /> : <MessageCircle size={20} />}
        <span>{open ? "Close" : "Chat"}</span>
        {unreadUsers.size > 0 && !open && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-600 px-1 text-[10px]">
            {unreadUsers.size}
          </span>
        )}
      </button>
    </div>
  );
}
