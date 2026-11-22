import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  BookOpen,
  CalendarDays,
  Cloud,
  Code2,
  Database,
  Github,
  Hash,
  Headset,
  LayoutDashboard,
  Mail,
  MessageCircle,
  PenTool,
  Phone,
  Plus,
  Search,
  Send,
  Server,
  ShoppingCart,
  Users,
  Video,
  Webhook,
  X,
} from "lucide-react";

const API_BASE = "/api";
const ROOM_REFRESH_MS = 4_000;
const PRESENCE_INTERVAL_MS = 20_000;

interface ChatUser {
  id: number;
  name: string;
  online: boolean;
}

interface Room {
  id: number;
  name: string;
  type: "channel" | "group";
  createdBy: number | null;
  createdAt: string;
}

interface ChatWebhookSettings {
  name: string;
  url: string;
  secretConfigured: boolean;
  mtlsEnabled: boolean;
}

interface DirectMessage {
  id: number;
  senderUserId: number;
  recipientUserId: number;
  message: string;
  createdAt: string;
}

interface RoomMessage {
  id: number;
  senderUserId: number;
  senderName: string;
  message: string;
  createdAt: string;
}

type Target = { kind: "dm"; user: ChatUser } | { kind: "room"; room: Room };
type MediaType = "audio" | "video";
type MentionSuggestion =
  | { kind: "person"; id: number; label: string; detail: string }
  | { kind: "role"; id: string; label: string; detail: string };
interface MentionRange {
  start: number;
  end: number;
  query: string;
}
interface IncomingCall {
  callId: string;
  callerUserId: number;
  callerName: string;
  roomType: "dm" | "room";
  roomId: number;
  mediaType: MediaType;
  iceServers: RTCIceServer[];
}
interface CallSession {
  callId?: string;
  target: Target;
  mediaType: MediaType;
  phase: "requesting" | "ringing" | "connecting" | "active";
}
interface RemoteStream {
  userId: number;
  name: string;
  stream: MediaStream;
}
interface SocketEvent {
  type: string;
  userId?: number;
  users?: ChatUser[];
  messages?: DirectMessage[];
  message?: DirectMessage;
  error?: string;
  callId?: string;
  callerUserId?: number;
  callerName?: string;
  roomType?: "dm" | "room";
  roomId?: number;
  mediaType?: MediaType;
  roomMessage?: RoomMessage;
  iceServers?: RTCIceServer[];
  participants?: Array<{ id: number; name: string }>;
  fromUserId?: number;
  userName?: string;
  payload?: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
}

interface VideoTileProps {
  stream: MediaStream;
  label: string;
  audioOnly?: boolean;
  muted?: boolean;
}

function VideoTile({ stream, label, audioOnly = false, muted = false }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream;
    void videoRef.current.play().catch((error: unknown) => {
      console.warn("Unable to play call media", error);
    });
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [stream]);
  return (
    <div className={`relative overflow-hidden rounded-xl bg-[#17191c] ${audioOnly ? "hidden" : "min-h-40"}`}>
      <video ref={videoRef} autoPlay playsInline muted={muted} className="h-full min-h-40 w-full object-cover" />
      <span className="absolute bottom-2 left-2 rounded bg-black/50 px-2 py-1 text-xs text-white">{label}</span>
    </div>
  );
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

function getMentionRange(value: string, cursor: number, selectionEnd = cursor): MentionRange | null {
  if (cursor !== selectionEnd) return null;
  const beforeCursor = value.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
  if (!match) return null;
  return {
    start: match.index + match[0].lastIndexOf("@"),
    end: cursor,
    query: match[1]!.toLowerCase(),
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export default function SlackWorkspace() {
  const [authorized, setAuthorized] = useState(false);
  const [connected, setConnected] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([]);
  const [roomMessages, setRoomMessages] = useState<RoomMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState<"channel" | "group" | null>(null);
  const [roomName, setRoomName] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<number[]>([]);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [webhookRoom, setWebhookRoom] = useState<Room | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookSettings, setWebhookSettings] = useState<ChatWebhookSettings | null>(null);
  const [webhookName, setWebhookName] = useState("#alerts");
  const [webhookUrl, setWebhookUrl] = useState("https://webhook.afeonbooks.com/usw-2");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clearWebhookSecret, setClearWebhookSecret] = useState(false);
  const [webhookMtls, setWebhookMtls] = useState(true);
  const [webhookCertificate, setWebhookCertificate] = useState("");
  const [webhookPrivateKey, setWebhookPrivateKey] = useState("");
  const [webhookError, setWebhookError] = useState("");
  const [webhookNotice, setWebhookNotice] = useState("");
  const [call, setCall] = useState<CallSession | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [voicemail, setVoicemail] = useState<{ target: Target; callId?: string } | null>(null);
  const [voicemailRecording, setVoicemailRecording] = useState(false);
  const [voicemailSeconds, setVoicemailSeconds] = useState(0);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);
  const [callError, setCallError] = useState("");
  const [callSoundBlocked, setCallSoundBlocked] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const currentUserIdRef = useRef<number | null>(null);
  const selectedRef = useRef<Target | null>(null);
  const callRef = useRef<CallSession | null>(null);
  const incomingCallRef = useRef<IncomingCall | null>(null);
  const roomsRef = useRef<Room[]>([]);
  const usersRef = useRef<ChatUser[]>([]);
  const peerConnectionsRef = useRef(new Map<number, RTCPeerConnection>());
  const pendingCandidatesRef = useRef(new Map<number, RTCIceCandidateInit[]>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([{ urls: "stun:stun.l.google.com:19302" }]);
  const outgoingRingtoneRef = useRef<HTMLAudioElement | null>(null);
  const incomingRingtoneRef = useRef<HTMLAudioElement | null>(null);
  const incomingRingtoneLoopsRef = useRef(0);
  const outgoingRingtoneLoopsRef = useRef(0);
  const voicemailRecorderRef = useRef<MediaRecorder | null>(null);
  const voicemailChunksRef = useRef<Blob[]>([]);
  const voicemailDiscardRef = useRef(false);
  const voicemailTimerRef = useRef<number | null>(null);
  const roomPollRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);

  currentUserIdRef.current = currentUserId;
  selectedRef.current = target;
  callRef.current = call;
  incomingCallRef.current = incomingCall;
  roomsRef.current = rooms;
  usersRef.current = users;

  const send = useCallback((event: object) => sendEvent(socketRef.current, event), []);

  const stopRingtone = useCallback(() => {
    for (const audio of [outgoingRingtoneRef.current, incomingRingtoneRef.current]) {
      if (!audio) continue;
      audio.onended = null;
      audio.pause();
      audio.currentTime = 0;
    }
    incomingRingtoneLoopsRef.current = 0;
    outgoingRingtoneLoopsRef.current = 0;
    setCallSoundBlocked(false);
  }, []);

  const startRingtone = useCallback(() => {
    stopRingtone();
    const audio = incomingRingtoneRef.current ?? new Audio("/assets/afeon-recieve-ringtone.mp3");
    incomingRingtoneRef.current = audio;
    audio.loop = false;
    audio.volume = 0.8;
    audio.onended = () => {
      incomingRingtoneLoopsRef.current += 1;
      if (incomingRingtoneLoopsRef.current >= 5) {
        const invite = incomingCallRef.current;
        stopRingtone();
        setIncomingCall(null);
        if (invite) send({ type: "call_unanswered", callId: invite.callId });
        return;
      }
      audio.currentTime = 0;
      void audio.play().catch(() => {
        setCallSoundBlocked(true);
      });
    };
    void audio.play().then(() => {
      setCallSoundBlocked(false);
      setCallError("");
    }).catch(() => {
      setCallSoundBlocked(true);
      setCallError("Your browser blocked the ringtone. Enable sound to hear incoming calls.");
    });
  }, [stopRingtone]);

  const startDialTone = useCallback(() => {
    stopRingtone();
    const audio = outgoingRingtoneRef.current ?? new Audio("/assets/afeon-out-ringtone.mp3");
    outgoingRingtoneRef.current = audio;
    audio.loop = false;
    audio.volume = 0.8;
    audio.onended = () => {
      outgoingRingtoneLoopsRef.current += 1;
      if (outgoingRingtoneLoopsRef.current >= 5) {
        const currentCall = callRef.current;
        stopRingtone();
        if (currentCall) {
          for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
          localStreamRef.current = null;
          setLocalStream(null);
          callRef.current = null;
          setCall(null);
          setVoicemail({ target: currentCall.target, callId: currentCall.callId });
        }
        return;
      }
      audio.currentTime = 0;
      void audio.play().catch(() => {
        setCallSoundBlocked(true);
      });
    };
    void audio.play().then(() => {
      setCallSoundBlocked(false);
      setCallError("");
    }).catch(() => {
      setCallSoundBlocked(true);
      setCallError("Your browser blocked the ringtone. Enable sound to hear the call ring.");
    });
  }, [stopRingtone]);

  const playCloseSound = useCallback(() => {
    stopRingtone();
    const context = new AudioContext();
    void context.resume().then(() => {
      [660, 440, 220].forEach((frequency, index) => {
        const start = context.currentTime + index * 0.12;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.10, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.10);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.11);
      });
      window.setTimeout(() => { void context.close(); }, 500);
    }).catch(() => { void context.close(); });
  }, [stopRingtone]);

  const createPeerConnection = useCallback((userId: number, shouldOffer: boolean) => {
    const existing = peerConnectionsRef.current.get(userId);
    if (existing) return existing;
    const connection = new RTCPeerConnection({ iceServers: iceServersRef.current });
    localStreamRef.current?.getTracks().forEach((track) => connection.addTrack(track, localStreamRef.current!));
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        send({
          type: "call_signal",
          callId: callRef.current?.callId,
          targetUserId: userId,
          payload: { candidate: event.candidate.toJSON() },
        });
      }
    };
    connection.ontrack = (event) => {
      const peer = usersRef.current.find((user) => user.id === userId);
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      setRemoteStreams((current) => [
        ...current.filter((item) => item.userId !== userId),
        { userId, name: peer?.name ?? `Staff #${userId}`, stream },
      ]);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") {
        setCallError("Could not establish the media connection. Check the TURN server configuration and try again.");
      }
    };
    peerConnectionsRef.current.set(userId, connection);
    if (shouldOffer) {
      void (async () => {
        try {
          const offer = await connection.createOffer();
          await connection.setLocalDescription(offer);
          send({
            type: "call_signal",
            callId: callRef.current?.callId,
            targetUserId: userId,
            payload: { description: connection.localDescription?.toJSON() },
          });
        } catch (cause) {
          setCallError(cause instanceof Error ? cause.message : "Unable to start a media connection.");
        }
      })();
    }
    return connection;
  }, [send]);

  const cleanupCall = useCallback(() => {
    stopRingtone();
    callRef.current = null;
    for (const connection of peerConnectionsRef.current.values()) connection.close();
    peerConnectionsRef.current.clear();
    pendingCandidatesRef.current.clear();
    for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams([]);
    setCall(null);
    setIncomingCall(null);
  }, [stopRingtone]);

  useEffect(() => {
    let active = true;
    let retryTimeout: number | undefined;
    let retryCount = 0;
    let sessionUserId: number | null = null;

    const connect = async () => {
      try {
        if (sessionUserId === null) {
          const response = await fetch(`${API_BASE}/chat/session`, { credentials: "include", cache: "no-store" });
          if (response.status === 401 || response.status === 403) {
            if (active) setAuthorized(false);
            return;
          }
          if (!response.ok) throw new Error(await readError(response, "Unable to verify staff access."));
          const session = await response.json() as { userId: number };
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
          let data: SocketEvent;
          try {
            data = JSON.parse(event.data) as SocketEvent;
          } catch {
            setError("Received an invalid chat response.");
            return;
          }
          if (data.type === "ready" && typeof data.userId === "number") {
            setCurrentUserId(data.userId);
          } else if (data.type === "users" && Array.isArray(data.users)) {
            setUsers(data.users);
          } else if (data.type === "history" && data.userId === (selectedRef.current?.kind === "dm" ? selectedRef.current.user.id : undefined)) {
            setDirectMessages(data.messages ?? []);
          } else if (data.type === "message" && data.message) {
            if (data.message.senderUserId === currentUserIdRef.current) {
              setSending(false);
              const peerId = data.message.recipientUserId;
              if (selectedRef.current?.kind === "dm" && selectedRef.current.user.id === peerId) {
                setDraft((current) => current === data.message!.message ? "" : current);
              }
            }
            const peerId = data.message.senderUserId === currentUserIdRef.current
              ? data.message.recipientUserId
              : data.message.senderUserId;
            if (selectedRef.current?.kind === "dm" && selectedRef.current.user.id === peerId) {
              setDirectMessages((current) => current.some((message) => message.id === data.message!.id) ? current : [...current, data.message!]);
            }
          } else if (data.type === "room_message" && data.roomId && data.roomMessage) {
            if (selectedRef.current?.kind === "room" && selectedRef.current.room.id === data.roomId) {
              setRoomMessages((current) => current.some((message) => message.id === data.roomMessage!.id) ? current : [...current, data.roomMessage!]);
            }
          } else if (data.type === "call_invite" && data.callId && data.callerUserId && data.roomType && data.roomId && data.mediaType) {
            const invite: IncomingCall = {
              callId: data.callId,
              callerUserId: data.callerUserId,
              callerName: data.callerName ?? `Staff #${data.callerUserId}`,
              roomType: data.roomType,
              roomId: data.roomId,
              mediaType: data.mediaType,
              iceServers: data.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
            };
            const callTarget: Target = invite.roomType === "dm"
              ? { kind: "dm", user: usersRef.current.find((user) => user.id === invite.callerUserId) ?? { id: invite.callerUserId, name: invite.callerName, online: true } }
              : { kind: "room", room: roomsRef.current.find((room) => room.id === invite.roomId) ?? { id: invite.roomId, name: `Room ${invite.roomId}`, type: "channel", createdBy: invite.callerUserId, createdAt: new Date().toISOString() } };
            setIncomingCall(invite);
            setTarget(callTarget);
            setCallError("");
            startRingtone();
          } else if (data.type === "call_started" && data.callId) {
            if (data.iceServers) iceServersRef.current = data.iceServers;
            const currentCall = callRef.current;
            if (currentCall) {
              const nextCall = { ...currentCall, callId: data.callId, phase: "ringing" as const };
              callRef.current = nextCall;
              setCall(nextCall);
            }
          } else if (data.type === "call_joined" && data.callId) {
            stopRingtone();
            if (data.iceServers) iceServersRef.current = data.iceServers;
            setIncomingCall(null);
            const currentCall = callRef.current;
            if (currentCall) {
              const nextCall = {
                ...currentCall,
                callId: data.callId,
                mediaType: data.mediaType ?? currentCall.mediaType,
                phase: "active" as const,
              };
              callRef.current = nextCall;
              setCall(nextCall);
            }
            for (const peer of data.participants ?? []) createPeerConnection(peer.id, false);
          } else if (data.type === "call_user_joined" && data.callId && data.userId) {
            if (callRef.current?.callId === data.callId) createPeerConnection(data.userId, true);
          } else if (data.type === "call_signal" && data.callId && data.fromUserId && data.payload) {
            if (callRef.current?.callId === data.callId) {
              void (async () => {
                const peerId = data.fromUserId!;
                const connection = createPeerConnection(peerId, false);
                try {
                  if (data.payload!.description) {
                    await connection.setRemoteDescription(data.payload!.description);
                    for (const candidate of pendingCandidatesRef.current.get(peerId) ?? []) {
                      await connection.addIceCandidate(candidate);
                    }
                    pendingCandidatesRef.current.delete(peerId);
                    if (data.payload!.description!.type === "offer") {
                      const answer = await connection.createAnswer();
                      await connection.setLocalDescription(answer);
                      send({
                        type: "call_signal",
                        callId: data.callId,
                        targetUserId: peerId,
                        payload: { description: connection.localDescription?.toJSON() },
                      });
                    }
                  } else if (data.payload!.candidate) {
                    if (connection.remoteDescription) {
                      await connection.addIceCandidate(data.payload!.candidate);
                    } else {
                      const queued = pendingCandidatesRef.current.get(peerId) ?? [];
                      queued.push(data.payload!.candidate!);
                      pendingCandidatesRef.current.set(peerId, queued);
                    }
                  }
                } catch (cause) {
                  setCallError(cause instanceof Error ? cause.message : "Unable to process call signaling.");
                }
              })();
            }
          } else if (data.type === "call_user_left" && data.callId && data.userId) {
            const connection = peerConnectionsRef.current.get(data.userId);
            connection?.close();
            peerConnectionsRef.current.delete(data.userId);
            setRemoteStreams((current) => current.filter((item) => item.userId !== data.userId));
          } else if (data.type === "call_voicemail_available" && data.callId) {
            stopRingtone();
            const currentCall = callRef.current;
            if (currentCall) {
              for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
              localStreamRef.current = null;
              setLocalStream(null);
              callRef.current = null;
              setCall(null);
              setVoicemail({ target: currentCall.target, callId: data.callId });
            }
          } else if (data.type === "call_invite_rejected") {
            playCloseSound();
            setCallError("That person declined the call.");
            cleanupCall();
          } else if (data.type === "call_ended" && data.callId) {
            stopRingtone();
            playCloseSound();
            if (data.callId === callRef.current?.callId) cleanupCall();
            setIncomingCall((current) => current?.callId === data.callId ? null : current);
          } else if (data.type === "call_error" && data.error) {
            playCloseSound();
            cleanupCall();
            setCallError(data.error);
          } else if (data.type === "error" && data.error) {
            setError(data.error);
            setSending(false);
          }
        };
        socket.onclose = (event) => {
          setConnected(false);
          setSending(false);
          if (callRef.current) cleanupCall();
          if (socketRef.current === socket) socketRef.current = null;
          if (!active || event.code === 1008) {
            if (event.code === 1008) setAuthorized(false);
            return;
          }
          retryCount += 1;
          retryTimeout = window.setTimeout(() => void connect(), Math.min(1_000 * 2 ** Math.min(retryCount, 5), 30_000));
        };
        socket.onerror = () => setError("Chat connection interrupted. Reconnecting…");
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Unable to connect to chat.");
        retryCount += 1;
        retryTimeout = window.setTimeout(() => void connect(), Math.min(1_000 * 2 ** Math.min(retryCount, 5), 30_000));
      }
    };

    void connect();
    return () => {
      active = false;
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      socketRef.current?.close();
      socketRef.current = null;
      cleanupCall();
    };
  }, [cleanupCall, createPeerConnection]);

  useEffect(() => {
    if (!authorized) return;
    let active = true;
    const loadRooms = async () => {
      try {
        const response = await fetch(`${API_BASE}/chat/rooms`, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(await readError(response, "Unable to load channels and group chats."));
        const result = await response.json() as { rooms: Room[] };
        if (active) setRooms(result.rooms);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load channels and group chats.");
      }
    };
    void loadRooms();
    const interval = window.setInterval(() => void loadRooms(), ROOM_REFRESH_MS * 3);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [authorized]);

  useEffect(() => {
    if (!authorized || !connected) return;
    const interval = window.setInterval(() => send({ type: "presence" }), PRESENCE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [authorized, connected, send]);

  useEffect(() => {
    if (!authorized || target?.kind !== "dm" || !connected) return;
    setDirectMessages([]);
    send({ type: "history", userId: target.user.id });
  }, [authorized, connected, target, send]);

  useEffect(() => {
    if (!authorized || target?.kind !== "room") {
      setRoomMessages([]);
      return;
    }
    const controller = new AbortController();
    const loadRoomMessages = async () => {
      if (roomPollRef.current) return;
      roomPollRef.current = true;
      try {
        const response = await fetch(`${API_BASE}/chat/rooms/${target.room.id}/messages`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await readError(response, "Unable to load this conversation."));
        const result = await response.json() as { messages: RoomMessage[] };
        if (!controller.signal.aborted) setRoomMessages(result.messages);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load this conversation.");
      } finally {
        roomPollRef.current = false;
      }
    };
    void loadRoomMessages();
    const interval = window.setInterval(() => void loadRoomMessages(), ROOM_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [authorized, target]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [directMessages, roomMessages]);

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!target || !message || sending) return;
    setSending(true);
    setError("");
    if (target.kind === "dm") {
      if (!send({ type: "send", recipientUserId: target.user.id, message })) {
        setSending(false);
        setError("Chat is reconnecting. Please try again.");
      }
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/chat/rooms/${target.room.id}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to send your message."));
      const saved = await response.json() as RoomMessage;
      setRoomMessages((current) => current.some((item) => item.id === saved.id) ? current : [...current, saved]);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send your message.");
    } finally {
      setSending(false);
    }
  };

  const openWebhookSettings = async (room: Room) => {
    setWebhookRoom(room);
    setWebhookLoading(true);
    setWebhookError("");
    setWebhookNotice("");
    setWebhookSettings(null);
    setWebhookName("#alerts");
    setWebhookUrl("https://webhook.afeonbooks.com/usw-2");
    setWebhookSecret("");
    setClearWebhookSecret(false);
    setWebhookMtls(true);
    setWebhookCertificate("");
    setWebhookPrivateKey("");
    try {
      const response = await fetch(`${API_BASE}/chat/rooms/${room.id}/webhook`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to load webhook settings."));
      const result = await response.json() as { webhook: ChatWebhookSettings | null };
      if (result.webhook) {
        setWebhookSettings(result.webhook);
        setWebhookName(result.webhook.name);
        setWebhookUrl(result.webhook.url);
        setWebhookMtls(result.webhook.mtlsEnabled);
      }
    } catch (cause) {
      setWebhookError(cause instanceof Error ? cause.message : "Unable to load webhook settings.");
    } finally {
      setWebhookLoading(false);
    }
  };

  const saveWebhookSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!webhookRoom || webhookSaving) return;
    setWebhookSaving(true);
    setWebhookError("");
    setWebhookNotice("");
    try {
      const response = await fetch(`${API_BASE}/chat/rooms/${webhookRoom.id}/webhook`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: webhookName,
          url: webhookUrl,
          webhookSecret,
          clearSecret: clearWebhookSecret,
          enableMtls: webhookMtls,
          clientCertificate: webhookCertificate,
          clientKey: webhookPrivateKey,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to save webhook settings."));
      const result = await response.json() as { webhook: ChatWebhookSettings };
      setWebhookSettings(result.webhook);
      setWebhookSecret("");
      setClearWebhookSecret(false);
      setWebhookCertificate("");
      setWebhookPrivateKey("");
      setWebhookNotice("Webhook saved. New messages in #alerts will be sent to this destination.");
    } catch (cause) {
      setWebhookError(cause instanceof Error ? cause.message : "Unable to save webhook settings.");
    } finally {
      setWebhookSaving(false);
    }
  };

  const deleteWebhookSettings = async () => {
    if (!webhookRoom || webhookSaving) return;
    setWebhookSaving(true);
    setWebhookError("");
    setWebhookNotice("");
    try {
      const response = await fetch(`${API_BASE}/chat/rooms/${webhookRoom.id}/webhook`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to remove the webhook."));
      setWebhookRoom(null);
      setWebhookSettings(null);
    } catch (cause) {
      setWebhookError(cause instanceof Error ? cause.message : "Unable to remove the webhook.");
    } finally {
      setWebhookSaving(false);
    }
  };

  const mentionSuggestions: MentionSuggestion[] = target?.kind === "room" && mentionRange
    ? [
      { kind: "role" as const, id: "staff", label: "staff", detail: "Staff role" },
      { kind: "role" as const, id: "admin", label: "admin", detail: "Admin role" },
      ...users.map((user) => ({
        kind: "person" as const,
        id: user.id,
        label: user.name,
        detail: user.online ? "Online" : "Staff member",
      })),
    ]
      .filter((suggestion) => suggestion.label.toLowerCase().includes(mentionRange.query))
      .slice(0, 8)
    : [];

  const insertMention = (suggestion: MentionSuggestion) => {
    if (!mentionRange) return;
    const insertion = `@${suggestion.label} `;
    const nextDraft = `${draft.slice(0, mentionRange.start)}${insertion}${draft.slice(mentionRange.end)}`.slice(0, 2000);
    const cursor = Math.min(mentionRange.start + insertion.length, nextDraft.length);
    setDraft(nextDraft);
    setMentionRange(null);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      messageInputRef.current?.focus();
      messageInputRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const createRoom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!showCreateRoom || !roomName.trim() || creatingRoom) return;
    setCreatingRoom(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/chat/rooms`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: showCreateRoom,
          name: roomName.trim(),
          userIds: showCreateRoom === "group" ? selectedMemberIds : [],
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to create this chat."));
      const result = await response.json() as { room: Room };
      setRooms((current) => [...current.filter((room) => room.id !== result.room.id), result.room]);
      setTarget({ kind: "room", room: result.room });
      setShowCreateRoom(null);
      setRoomName("");
      setSelectedMemberIds([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create this chat.");
    } finally {
      setCreatingRoom(false);
    }
  };

  const setupLocalMedia = async (mediaType: MediaType): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Audio and video calls are not available in this browser.");
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mediaType === "video",
    });
  };

  const startCall = async (mediaType: MediaType) => {
    if (!target || call || incomingCall) return;
    setCallError("");
    setError("");
    const newCall: CallSession = { target, mediaType, phase: "requesting" };
    callRef.current = newCall;
    setCall(newCall);
    startDialTone();
    try {
      const stream = await setupLocalMedia(mediaType);
      localStreamRef.current = stream;
      setLocalStream(stream);
      iceServersRef.current = [{ urls: "stun:stun.l.google.com:19302" }];
      const started = send({
        type: "call_start",
        roomType: target.kind === "dm" ? "dm" : "room",
        roomId: target.kind === "dm" ? target.user.id : target.room.id,
        mediaType,
      });
      if (!started) throw new Error("Chat is reconnecting. Please try the call again.");
    } catch (cause) {
      cleanupCall();
      setCallError(cause instanceof Error ? cause.message : "Unable to start the call.");
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;
    stopRingtone();
    setCallError("");
    try {
      const stream = await setupLocalMedia(incomingCall.mediaType);
      localStreamRef.current = stream;
      iceServersRef.current = incomingCall.iceServers;
      setLocalStream(stream);
      const callTarget: Target = incomingCall.roomType === "dm"
        ? { kind: "dm", user: users.find((user) => user.id === incomingCall.callerUserId) ?? { id: incomingCall.callerUserId, name: incomingCall.callerName, online: true } }
        : { kind: "room", room: rooms.find((room) => room.id === incomingCall.roomId) ?? { id: incomingCall.roomId, name: `Room ${incomingCall.roomId}`, type: "channel", createdBy: incomingCall.callerUserId, createdAt: new Date().toISOString() } };
      setTarget(callTarget);
      const newCall: CallSession = {
        callId: incomingCall.callId,
        target: callTarget,
        mediaType: incomingCall.mediaType,
        phase: "connecting",
      };
      callRef.current = newCall;
      setCall(newCall);
      if (!send({ type: "call_accept", callId: incomingCall.callId })) throw new Error("Chat is reconnecting. Please try again.");
      setIncomingCall(null);
    } catch (cause) {
      send({ type: "call_reject", callId: incomingCall.callId });
      cleanupCall();
      setCallError(cause instanceof Error ? cause.message : "Unable to join the call.");
    }
  };

  const rejectCall = () => {
    stopRingtone();
    if (incomingCall) send({ type: "call_reject", callId: incomingCall.callId });
    setIncomingCall(null);
  };

  const endCall = () => {
    playCloseSound();
    if (call?.callId) send({ type: "call_leave", callId: call.callId });
    cleanupCall();
  };

  const startVoicemailRecording = async () => {
    if (!voicemail || voicemailRecording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setCallError("Voice recording is not available in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      voicemailRecorderRef.current = recorder;
      voicemailChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) voicemailChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        if (voicemailDiscardRef.current) {
          voicemailDiscardRef.current = false;
          voicemailChunksRef.current = [];
          setVoicemailRecording(false);
          return;
        }
        if (voicemailTimerRef.current !== null) window.clearInterval(voicemailTimerRef.current);
        voicemailTimerRef.current = null;
        const blob = new Blob(voicemailChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size > 1_500_000) {
          setCallError("Voice messages must be under 1.5 MB.");
          setVoicemailRecording(false);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          if (!dataUrl) {
            setCallError("Unable to prepare the voice message.");
            setVoicemailRecording(false);
            return;
          }
          if (voicemail.target.kind === "dm") {
            send({
              type: "call_voicemail",
              callId: voicemail.callId,
              targetUserId: voicemail.target.user.id,
              audio: dataUrl,
            });
            if (voicemail.callId) send({ type: "call_leave", callId: voicemail.callId });
          }
          setVoicemail(null);
          setVoicemailRecording(false);
          setVoicemailSeconds(0);
        };
        reader.readAsDataURL(blob);
      };
      recorder.start();
      setVoicemailRecording(true);
      setVoicemailSeconds(0);
      voicemailTimerRef.current = window.setInterval(() => {
        setVoicemailSeconds((seconds) => {
          if (seconds + 1 >= 60) {
            voicemailRecorderRef.current?.stop();
            return 60;
          }
          return seconds + 1;
        });
      }, 1_000);
    } catch (cause) {
      setCallError(cause instanceof Error ? cause.message : "Unable to access the microphone.");
    }
  };

  const stopVoicemailRecording = () => {
    if (voicemailRecorderRef.current?.state === "recording") voicemailRecorderRef.current.stop();
  };

  const cancelVoicemail = () => {
    voicemailDiscardRef.current = true;
    if (voicemailRecorderRef.current?.state === "recording") voicemailRecorderRef.current.stop();
    if (voicemailTimerRef.current !== null) window.clearInterval(voicemailTimerRef.current);
    voicemailTimerRef.current = null;
    if (voicemail?.callId) send({ type: "call_leave", callId: voicemail.callId });
    setVoicemail(null);
    setVoicemailRecording(false);
    setVoicemailSeconds(0);
  };

  const toggleMember = (userId: number) => {
    setSelectedMemberIds((current) => current.includes(userId)
      ? current.filter((id) => id !== userId)
      : current.length < 5 ? [...current, userId] : current);
  };

  const filteredUsers = users.filter((user) => user.id !== currentUserId && user.name.toLowerCase().includes(search.toLowerCase()));
  const filteredRooms = rooms.filter((room) => room.name.toLowerCase().includes(search.toLowerCase()));
  const shownMessages = target?.kind === "dm" ? directMessages : roomMessages;

  if (!authorized) {
    return (
      <main className="flex h-dvh items-center justify-center bg-[#1a1d21] px-6 text-center font-sans text-white">
        <div>
          <h1 className="text-xl font-semibold">Sign in with GitHub</h1>
          <p className="mt-2 text-sm text-white/60">Use an authorized staff account to open the workspace.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 z-[100] flex bg-white font-sans text-[#1d1c1d]">
      <aside className="hidden w-[68px] shrink-0 flex-col items-center gap-4 bg-[#1a1d21] py-4 text-white sm:flex">
        <a href="/" title="AFEON Workspace" className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#80d7f6] text-sm font-black text-[#111111]">A</a>
        <a href="/main-admin#orders" title="Main Admin" className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"><LayoutDashboard size={20} /></a>
        <a href="/support-chat" title="Customer Support" className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"><Headset size={20} /></a>
        <span className="mt-auto text-[10px] text-white/35">AFEON</span>
      </aside>

      <aside className={`${target ? "hidden sm:flex" : "flex"} w-60 shrink-0 flex-col bg-[#222529] text-[#d1d2d3] sm:w-64`}>
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <a href="/" className="truncate text-sm font-bold text-white hover:underline">AFEON Books</a>
          <span className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-green-400" : "bg-amber-400"}`} title={connected ? "Connected" : "Reconnecting"} />
        </header>
        <div className="px-3 py-3">
          <label className="flex items-center gap-2 rounded-md bg-[#34373b] px-2.5 py-2 text-white/70">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search chats" placeholder="Search" className="w-full bg-transparent text-xs text-white outline-none placeholder:text-white/50" />
          </label>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <div className="mb-1 px-2 pt-2 text-[11px] font-bold uppercase tracking-wider text-white/55">Workspace tools</div>
          <a href="/support-chat" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><Headset size={15} className="shrink-0 text-white/45" />Customer Support</a>
          <a href="/calendar" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><CalendarDays size={15} className="shrink-0 text-white/45" />Calendar</a>
          <a href="/main-admin#orders" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><LayoutDashboard size={15} className="shrink-0 text-white/45" />Main Admin</a>
          <a href="/site-editor#site-editor" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><PenTool size={15} className="shrink-0 text-white/45" />Site Editor</a>
          <a href="/pos" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><ShoppingCart size={15} className="shrink-0 text-white/45" />POS Checkout</a>
          <a href="/zoho-mail" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><Mail size={15} className="shrink-0 text-white/45" />Zoho Mail</a>
          <a href="https://github.com/acdu1/afeonbooks" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><Github size={15} className="shrink-0 text-white/45" />GitHub</a>
          <a href="https://ubiquitous-guacamole-x545p5p7996439pxj.github.dev/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><Code2 size={15} className="shrink-0 text-white/45" />GitHub Codespaces</a>
          <a href="https://dash.cloudflare.com/a130548b1748b2365a5c0e027fe3ebd8/home" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><Cloud size={15} className="shrink-0 text-white/45" />Cloudflare</a>
          <a href="https://supabase.com/dashboard/project/msxfhfdeqxqvjuypcspm" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><Database size={15} className="shrink-0 text-white/45" />Supabase</a>
          <a href="https://dashboard.render.com/web/srv-da57c6jbc2fs738388lg" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><Server size={15} className="shrink-0 text-white/45" />Render</a>
          <a href="https://status.afeonbooks.com/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><Activity size={15} className="shrink-0 text-white/45" />StatusPage</a>
          <a href="https://editor.reedsy.com/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white/75 hover:bg-white/10"><BookOpen size={15} className="shrink-0 text-white/45" />Reedsy Book Editor</a>
          <div className="mb-1 flex items-center justify-between px-2 pt-2 text-[11px] font-bold uppercase tracking-wider text-white/55">
            <span>Channels</span>
            <button type="button" onClick={() => { setShowCreateRoom("channel"); setRoomName(""); }} title="Create channel" className="rounded p-1 hover:bg-white/10"><Plus size={15} /></button>
          </div>
          {filteredRooms.filter((room) => room.type === "channel").map((room) => (
            <button type="button" key={room.id} onClick={() => setTarget({ kind: "room", room })} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/10 ${target?.kind === "room" && target.room.id === room.id ? "bg-[#1164a3] text-white" : "text-white/75"}`}>
              <Hash size={15} className="shrink-0 text-white/45" />
              <span className="truncate">{room.name}</span>
            </button>
          ))}
          <div className="mb-1 mt-6 flex items-center justify-between px-2 text-[11px] font-bold uppercase tracking-wider text-white/55">
            <span>Group messages</span>
            <button type="button" onClick={() => { setShowCreateRoom("group"); setRoomName(""); setSelectedMemberIds([]); }} title="Create group chat" className="rounded p-1 hover:bg-white/10"><Plus size={15} /></button>
          </div>
          {filteredRooms.filter((room) => room.type === "group").map((room) => (
            <button type="button" key={room.id} onClick={() => setTarget({ kind: "room", room })} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/10 ${target?.kind === "room" && target.room.id === room.id ? "bg-[#1164a3] text-white" : "text-white/75"}`}>
              <Users size={15} className="shrink-0 text-white/45" />
              <span className="truncate">{room.name}</span>
            </button>
          ))}
          <div className="mb-1 mt-6 px-2 text-[11px] font-bold uppercase tracking-wider text-white/55">Direct messages</div>
          {filteredUsers.map((user) => (
            <button type="button" key={user.id} onClick={() => setTarget({ kind: "dm", user })} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/10 ${target?.kind === "dm" && target.user.id === user.id ? "bg-[#1164a3] text-white" : "text-white/75"}`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${user.online ? "bg-green-400" : "bg-white/25"}`} />
              <span className="truncate">{user.name}</span>
            </button>
          ))}
        </nav>
        <footer className="flex items-center justify-between border-t border-white/10 px-3 py-3 text-xs">
          <a href="/" className="text-white/60 hover:text-white">Workspace</a>
          <span className="text-white/40">{connected ? "Live" : "Connecting…"}</span>
        </footer>
      </aside>

      <section className={`${target ? "flex" : "hidden sm:flex"} min-w-0 flex-1 flex-col`}>
        {target ? (
          <>
            <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-black/10 px-4 sm:px-6">
              <div className="min-w-0">
                <h1 className="flex items-center gap-1.5 truncate text-sm font-bold">
                  <button type="button" onClick={() => setTarget(null)} aria-label="Back to chat list" className="mr-1 rounded p-1 hover:bg-black/5 sm:hidden"><Users size={16} /></button>
                  {target.kind === "room" ? target.room.type === "channel" ? <Hash size={16} /> : <Users size={16} /> : <MessageCircle size={16} />}
                  {target.kind === "room" ? target.room.name : target.user.name}
                </h1>
                <p className="mt-0.5 text-xs text-black/50">{target.kind === "room" ? target.room.type === "channel" ? "Public channel" : "Group message" : target.user.online ? "Active now" : "Direct message"}</p>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" title="Start audio call" onClick={() => void startCall("audio")} disabled={!connected || Boolean(call) || Boolean(incomingCall)} className="rounded-md p-2 hover:bg-black/5 disabled:opacity-40"><Phone size={18} /></button>
                <button type="button" title="Start video call" onClick={() => void startCall("video")} disabled={!connected || Boolean(call) || Boolean(incomingCall)} className="rounded-md p-2 hover:bg-black/5 disabled:opacity-40"><Video size={18} /></button>
                {target.kind === "room" && target.room.type === "channel" && target.room.name.toLowerCase() === "alerts" && (
                  <button type="button" title="Configure #alerts webhook" onClick={() => void openWebhookSettings(target.room)} className="rounded-md p-2 hover:bg-black/5"><Webhook size={18} /></button>
                )}
                <a href="/" title="Workspace" className="ml-1 rounded-md px-2 py-1.5 text-xs text-black/55 hover:bg-black/5">Workspace</a>
              </div>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5 sm:px-8">
              {target.kind === "room" && roomMessages.length === 0 && <p className="py-10 text-center text-sm text-black/45">This is the beginning of {target.room.type === "channel" ? `#${target.room.name}` : target.room.name}.</p>}
              {target.kind === "dm" && directMessages.length === 0 && <p className="py-10 text-center text-sm text-black/45">Start a conversation with {target.user.name}.</p>}
              {target.kind === "room"
                ? roomMessages.map((message) => (
                  <article key={message.id} className="flex gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#80d7f6]/25 text-sm font-bold text-[#236078]">{message.senderName.slice(0, 1).toUpperCase()}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold">{message.senderName}<time className="ml-2 text-[10px] font-normal text-black/40">{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{message.message}</p>
                    </div>
                  </article>
                ))
                : directMessages.map((message) => {
                  const mine = message.senderUserId === currentUserId;
                  return (
                    <article key={message.id} className={`flex gap-3 ${mine ? "flex-row-reverse text-right" : ""}`}>
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#80d7f6]/25 text-sm font-bold text-[#236078]">{(mine ? "You" : target.user.name).slice(0, 1).toUpperCase()}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-bold">{mine ? "You" : target.user.name}<time className="ml-2 text-[10px] font-normal text-black/40">{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></p>
                        {message.message.startsWith("data:audio/") ? (
                  <audio className={`mt-2 block max-w-full ${mine ? "ml-auto" : ""}`} controls preload="metadata" src={message.message} />
                ) : (
                  <p className={`mt-1 inline-block max-w-full whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-left text-sm leading-6 ${mine ? "bg-[#80d7f6]/30" : "bg-[#f3f3f3]"}`}>{message.message}</p>
                )}
                      </div>
                    </article>
                  );
                })}
              <div ref={messagesEndRef} />
            </div>
            <form onSubmit={sendMessage} className="relative mx-4 mb-4 flex items-end gap-2 rounded-xl border border-black/20 bg-white p-2 sm:mx-8">
              {mentionSuggestions.length > 0 && (
                <div role="listbox" aria-label="Mention suggestions" className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-72 overflow-y-auto rounded-lg border border-black/10 bg-white p-1 shadow-xl">
                  {mentionSuggestions.map((suggestion, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === mentionIndex}
                      key={`${suggestion.kind}:${suggestion.id}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(suggestion)}
                      className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm ${index === mentionIndex ? "bg-[#80d7f6]/30" : "hover:bg-black/5"}`}
                    >
                      <span className="truncate font-medium">@{suggestion.label}</span>
                      <span className="shrink-0 text-xs text-black/45">{suggestion.detail}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea ref={messageInputRef} value={draft} onChange={(event) => {
                const nextDraft = event.target.value.slice(0, 2000);
                setDraft(nextDraft);
                const nextRange = getMentionRange(nextDraft, event.target.selectionStart, event.target.selectionEnd);
                setMentionRange(nextRange);
                setMentionIndex(0);
              }} onClick={(event) => {
                setMentionRange(getMentionRange(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd));
              }} onKeyDown={(event) => {
                if (mentionSuggestions.length > 0 && event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
                  return;
                }
                if (mentionSuggestions.length > 0 && event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((index) => (index - 1 + mentionSuggestions.length) % mentionSuggestions.length);
                  return;
                }
                if (mentionSuggestions.length > 0 && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  insertMention(mentionSuggestions[mentionIndex]!);
                  return;
                }
                if (event.key === "Escape" && mentionRange) {
                  setMentionRange(null);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} onKeyUp={(event) => {
                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                  setMentionRange(getMentionRange(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd));
                }
              }} placeholder={`Message ${target.kind === "room" ? target.room.type === "channel" ? `#${target.room.name}` : target.room.name : target.user.name}`} rows={1} maxLength={2000} aria-label="Write a message" aria-autocomplete="list" aria-expanded={mentionSuggestions.length > 0} className="max-h-28 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none" />
              <button type="submit" disabled={!draft.trim() || sending || !connected} aria-label="Send message" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#80d7f6] text-[#111111] hover:bg-[#6ac9eb] disabled:opacity-40"><Send size={17} /></button>
            </form>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#80d7f6]/30 text-[#236078]"><MessageCircle size={30} /></span>
            <h1 className="mt-5 text-xl font-bold">Welcome to AFEON Books</h1>
            <p className="mt-2 max-w-sm text-sm text-black/55">Choose a channel or message from the sidebar, or start a new conversation.</p>
          </div>
        )}
        {error && <p role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</p>}
        {callError && !call && !incomingCall && <p role="alert" className="fixed bottom-4 right-4 z-[140] max-w-sm rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 shadow-lg">{callError}</p>}
      </section>

      {showCreateRoom && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowCreateRoom(null);
        }}>
          <form onSubmit={createRoom} className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">{showCreateRoom === "channel" ? "Create a channel" : "Start a group message"}</h2>
              <button type="button" onClick={() => setShowCreateRoom(null)} aria-label="Close dialog" className="rounded p-1 hover:bg-black/5"><X size={18} /></button>
            </div>
            <label className="mt-5 block text-sm font-semibold">Name
              <input value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={50} required className="mt-2 w-full rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-[#80d7f6]" />
            </label>
            {showCreateRoom === "channel" ? (
              <p className="mt-3 text-xs text-black/50">Channels are public to all staff and admins.</p>
            ) : (
              <fieldset className="mt-4">
                <legend className="text-sm font-semibold">Invite up to five coworkers</legend>
                <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
                  {users.filter((user) => user.id !== currentUserId).map((user) => (
                    <label key={user.id} className="flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-black/5">
                      <input type="checkbox" checked={selectedMemberIds.includes(user.id)} onChange={() => toggleMember(user.id)} disabled={!selectedMemberIds.includes(user.id) && selectedMemberIds.length >= 5} />
                      {user.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {showCreateRoom === "group" && selectedMemberIds.length === 0 && <p className="mt-2 text-xs text-amber-700">Select at least one coworker.</p>}
            <button type="submit" disabled={creatingRoom || !roomName.trim() || (showCreateRoom === "group" && selectedMemberIds.length === 0)} className="mt-5 w-full rounded-md bg-[#80d7f6] px-4 py-2.5 text-sm font-bold text-[#111111] hover:bg-[#6ac9eb] disabled:opacity-40">{creatingRoom ? "Creating…" : showCreateRoom === "channel" ? "Create channel" : "Create group"}</button>
          </form>
        </div>
      )}

      {webhookRoom && (
        <div className="fixed inset-0 z-[125] flex items-center justify-center overflow-y-auto bg-black/50 p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !webhookSaving) setWebhookRoom(null);
        }}>
          <form onSubmit={saveWebhookSettings} className="my-auto w-full max-w-xl rounded-xl bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold">#alerts Generic Webhook</h2>
                <p className="mt-1 text-xs text-black/50">Send new channel messages to an HTTPS destination.</p>
              </div>
              <button type="button" onClick={() => setWebhookRoom(null)} aria-label="Close dialog" className="rounded p-1 hover:bg-black/5"><X size={18} /></button>
            </div>
            {webhookLoading ? <p className="py-8 text-center text-sm text-black/50">Loading webhook settings…</p> : (
              <>
                <label className="mt-5 block text-sm font-semibold">Name
                  <input value={webhookName} onChange={(event) => setWebhookName(event.target.value)} maxLength={80} required className="mt-2 w-full rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-[#80d7f6]" />
                </label>
                <label className="mt-4 block text-sm font-semibold">URL
                  <select value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} className="mt-2 w-full rounded-md border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-[#80d7f6]">
                    <option value="https://webhook.afeonbooks.com/usw-2">https://webhook.afeonbooks.com/usw-2 (main)</option>
                    <option value="https://webhook.afeonbooks.com/use-2">https://webhook.afeonbooks.com/use-2 (failover)</option>
                  </select>
                </label>
                <label className="mt-4 block text-sm font-semibold">Webhook secret (optional)
                  <input type="password" autoComplete="new-password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} maxLength={2048} placeholder={webhookSettings?.secretConfigured ? "Saved; leave blank to keep current secret" : "Enter a shared secret"} className="mt-2 w-full rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-[#80d7f6]" />
                </label>
                {webhookSettings?.secretConfigured && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-black/65">
                    <input type="checkbox" checked={clearWebhookSecret} onChange={(event) => setClearWebhookSecret(event.target.checked)} />
                    Remove the saved webhook secret
                  </label>
                )}
                <label className="mt-4 flex items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" checked={webhookMtls} onChange={(event) => setWebhookMtls(event.target.checked)} />
                  Enable mTLS
                </label>
                {webhookMtls && (
                  <div className="mt-3 space-y-3">
                    <label className="block text-sm font-semibold">Client certificate (PEM)
                      <textarea value={webhookCertificate} onChange={(event) => setWebhookCertificate(event.target.value)} rows={4} autoComplete="off" placeholder={webhookSettings?.mtlsEnabled ? "Saved; leave blank to keep current certificate" : "-----BEGIN CERTIFICATE-----"} className="mt-2 w-full rounded-md border border-black/15 px-3 py-2 font-mono text-xs outline-none focus:border-[#80d7f6]" />
                    </label>
                    <label className="block text-sm font-semibold">Client private key (PEM)
                      <textarea value={webhookPrivateKey} onChange={(event) => setWebhookPrivateKey(event.target.value)} rows={4} autoComplete="off" placeholder={webhookSettings?.mtlsEnabled ? "Saved; leave blank to keep current key" : "-----BEGIN PRIVATE KEY-----"} className="mt-2 w-full rounded-md border border-black/15 px-3 py-2 font-mono text-xs outline-none focus:border-[#80d7f6]" />
                    </label>
                    <p className="text-xs text-black/50">Credentials are encrypted in the API database and never returned to the browser after saving.</p>
                  </div>
                )}
                {webhookError && <p role="alert" className="mt-3 text-sm text-red-700">{webhookError}</p>}
                {webhookNotice && <p role="status" className="mt-3 text-sm text-green-700">{webhookNotice}</p>}
                <div className="mt-5 flex flex-wrap justify-between gap-2">
                  {webhookSettings && <button type="button" onClick={() => void deleteWebhookSettings()} disabled={webhookSaving} className="rounded-md border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40">Remove webhook</button>}
                  <div className="ml-auto flex gap-2">
                    <button type="button" onClick={() => setWebhookRoom(null)} className="rounded-md px-3 py-2 text-sm hover:bg-black/5">Cancel</button>
                    <button type="submit" disabled={webhookSaving} className="rounded-md bg-[#80d7f6] px-4 py-2 text-sm font-bold text-[#111111] hover:bg-[#6ac9eb] disabled:opacity-40">{webhookSaving ? "Saving…" : "Save destination"}</button>
                  </div>
                </div>
              </>
            )}
          </form>
        </div>
      )}

      {(call || incomingCall || voicemail) && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-[#101214]/90 p-4 text-white">
          {voicemail ? (
            <section className="w-full max-w-sm rounded-2xl bg-[#242629] p-6 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#80d7f6] text-[#111111]"><Phone /></div>
              <h2 className="mt-4 text-lg font-bold">Leave a voice message</h2>
              <p className="mt-1 text-sm text-white/60">Send a recording to {voicemail.target.kind === "dm" ? voicemail.target.user.name : voicemail.target.room.name}</p>
              {callError && <p role="alert" className="mt-3 text-sm text-red-300">{callError}</p>}
              {voicemailRecording ? (
                <>
                  <p className="mt-5 text-2xl font-bold tabular-nums">0:{String(voicemailSeconds).padStart(2, "0")}</p>
                  <p className="mt-1 text-xs text-white/50">Recording</p>
                  <button type="button" onClick={stopVoicemailRecording} className="mt-5 rounded-md bg-green-600 px-5 py-3 text-sm font-bold hover:bg-green-500">Send voice message</button>
                </>
              ) : (
                <button type="button" onClick={() => void startVoicemailRecording()} className="mt-5 rounded-md bg-[#80d7f6] px-5 py-3 text-sm font-bold text-[#111111] hover:bg-[#6ac9eb]">Start recording</button>
              )}
              <button type="button" onClick={cancelVoicemail} className="mt-3 block w-full rounded-md px-3 py-2 text-sm text-white/70 hover:bg-white/10">Cancel</button>
            </section>
          ) : incomingCall && !call ? (
            <section className="w-full max-w-sm rounded-2xl bg-[#242629] p-6 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#80d7f6] text-[#111111]">{incomingCall.mediaType === "video" ? <Video /> : <Phone />}</div>
              <h2 className="mt-4 text-lg font-bold">{incomingCall.callerName} is calling</h2>
              <p className="mt-1 text-sm text-white/60">{incomingCall.mediaType === "video" ? "Video call" : "Audio call"}</p>
              {callError && <p role="alert" className="mt-3 text-sm text-red-300">{callError}</p>}
              {callSoundBlocked && <button type="button" onClick={startRingtone} className="mt-3 rounded-md bg-white/10 px-3 py-2 text-sm hover:bg-white/20">Enable sound</button>}
              <div className="mt-6 flex justify-center gap-3">
                <button type="button" onClick={rejectCall} className="rounded-full bg-red-600 px-5 py-3 text-sm font-bold hover:bg-red-500">Decline</button>
                <button type="button" onClick={() => void acceptCall()} className="rounded-full bg-green-600 px-5 py-3 text-sm font-bold hover:bg-green-500">Answer</button>
              </div>
            </section>
          ) : call ? (
            <section className="w-full max-w-5xl">
              <header className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold">{call.target.kind === "dm" ? call.target.user.name : call.target.room.name}</h2>
                  <p className="text-sm text-white/60">{call.phase === "requesting" ? "Requesting microphone and camera…" : call.phase === "ringing" ? "Calling… waiting for someone to answer" : call.phase === "connecting" ? "Connecting call…" : call.mediaType === "video" ? "Video call" : "Audio call"}</p>
                </div>
                <button type="button" onClick={endCall} disabled={!call.callId} aria-label="End call" className="rounded-full bg-red-600 p-3 hover:bg-red-500 disabled:opacity-40"><Phone size={20} className="rotate-[135deg]" /></button>
              </header>
              {callError && <p role="alert" className="mb-3 text-sm text-red-300">{callError}</p>}
              {callSoundBlocked && <button type="button" onClick={startDialTone} className="mb-3 rounded-md bg-white/10 px-3 py-2 text-sm hover:bg-white/20">Enable sound</button>}
              {call.mediaType === "video" ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {localStream && <VideoTile stream={localStream} label="You" muted />}
                  {remoteStreams.map((peer) => <VideoTile key={peer.userId} stream={peer.stream} label={peer.name} />)}
                  {!remoteStreams.length && <div className="flex min-h-40 items-center justify-center rounded-xl bg-[#17191c] text-sm text-white/50">Waiting for others to join…</div>}
                </div>
              ) : (
                <div className="mx-auto flex min-h-60 max-w-md flex-col items-center justify-center rounded-2xl bg-[#242629]">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#80d7f6] text-2xl font-bold text-[#111111]">{remoteStreams.length + 1}</div>
                  <p className="mt-4 text-sm text-white/60">{remoteStreams.length ? remoteStreams.map((peer) => peer.name).join(", ") : "Waiting for others to join…"}</p>
                </div>
              )}
              {call.mediaType === "audio" && localStream && <VideoTile stream={localStream} label="You" audioOnly muted />}
              {call.mediaType === "audio" && remoteStreams.map((peer) => <VideoTile key={peer.userId} stream={peer.stream} label={peer.name} audioOnly />)}
              <p className="mt-4 text-center text-xs text-white/45">Calls support up to six people. Network-restricted calls need a configured TURN server.</p>
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
