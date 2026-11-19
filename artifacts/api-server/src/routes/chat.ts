import { type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { chatMessagesTable, chatPresenceTable, chatRoomMembersTable, chatRoomMessagesTable, chatRoomsTable, db, usersTable } from "@workspace/db";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { loadStaffUserFromSessionToken, requireStaffAccess, requireUser } from "../lib/auth";
import { isAllowedOrigin } from "../lib/origin";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const ONLINE_WINDOW_MS = 75_000;
const MAX_MESSAGE_LENGTH = 2_000;
const SESSION_COOKIE = "afeonbooks_session";
const CHAT_SOCKET_PATH = "/api/chat/socket";
const MAX_ROOM_MESSAGE_LENGTH = 2_000;
const MAX_CALL_PARTICIPANTS = 6;

router.use("/chat", (_request, response, next) => {
  response.setHeader("Cache-Control", "private, no-store");
  next();
});

router.get("/chat/session", requireUser, requireStaffAccess("staff", "admin"), (request, response) => {
  response.json({ userId: request.user!.id });
});

function parseId(value: unknown): number | undefined {
  const id = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function userCanAccessRoom(roomId: number, userId: number): Promise<boolean> {
  const [room] = await db.select({ id: chatRoomsTable.id, type: chatRoomsTable.type })
    .from(chatRoomsTable)
    .where(eq(chatRoomsTable.id, roomId))
    .limit(1);
  if (!room) return false;
  if (room.type === "channel") return true;
  const [membership] = await db.select({ userId: chatRoomMembersTable.userId })
    .from(chatRoomMembersTable)
    .where(and(
      eq(chatRoomMembersTable.roomId, roomId),
      eq(chatRoomMembersTable.userId, userId),
    ))
    .limit(1);
  return Boolean(membership);
}

router.get("/chat/rooms", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  await db.insert(chatRoomsTable)
    .values({ name: "general", type: "channel", createdBy: request.user!.id })
    .onConflictDoNothing();
  const [channels, groups] = await Promise.all([
    db.select({
      id: chatRoomsTable.id,
      name: chatRoomsTable.name,
      type: chatRoomsTable.type,
      createdBy: chatRoomsTable.createdBy,
      createdAt: chatRoomsTable.createdAt,
    })
      .from(chatRoomsTable)
      .where(eq(chatRoomsTable.type, "channel"))
      .orderBy(chatRoomsTable.name),
    db.select({
      id: chatRoomsTable.id,
      name: chatRoomsTable.name,
      type: chatRoomsTable.type,
      createdBy: chatRoomsTable.createdBy,
      createdAt: chatRoomsTable.createdAt,
    })
      .from(chatRoomsTable)
      .innerJoin(chatRoomMembersTable, eq(chatRoomsTable.id, chatRoomMembersTable.roomId))
      .where(and(
        eq(chatRoomsTable.type, "group"),
        eq(chatRoomMembersTable.userId, request.user!.id),
      ))
      .orderBy(chatRoomsTable.name),
  ]);
  response.json({ rooms: [...channels, ...groups] });
});

router.post("/chat/rooms", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const type = request.body?.type;
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const requestedUserIds: unknown = request.body?.userIds;
  const selectedIds = Array.isArray(requestedUserIds) ? requestedUserIds.map(parseId) : [];
  const selectedMemberIds = selectedIds.filter((id): id is number => id !== undefined);
  if ((type !== "channel" && type !== "group") || name.length < 1 || name.length > 50) {
    response.status(400).json({ error: "Enter a channel or group name of 1 to 50 characters." });
    return;
  }
  if (type === "group" && (
    !Array.isArray(requestedUserIds) ||
    requestedUserIds.length < 1 ||
    requestedUserIds.length > 5 ||
    selectedMemberIds.length !== requestedUserIds.length
  )) {
    response.status(400).json({ error: "Choose at least one other staff member for a group chat." });
    return;
  }
  const memberIds = type === "group"
    ? [...new Set([request.user!.id, ...selectedMemberIds])]
    : [];
  if (type === "group" && (memberIds.length < 2 || memberIds.length !== selectedMemberIds.length + 1)) {
    response.status(400).json({ error: "Choose at least one other staff member for a group chat." });
    return;
  }
  if (type === "group" && memberIds.length > 6) {
    response.status(400).json({ error: "Group chats can contain up to six staff members." });
    return;
  }
  if (memberIds.length > 1) {
    const members = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(and(
        inArray(usersTable.id, memberIds),
        or(eq(usersTable.role, "staff"), eq(usersTable.role, "admin")),
      ));
    if (members.length !== memberIds.length) {
      response.status(400).json({ error: "Group chats can only include staff and admins." });
      return;
    }
  }
  try {
    const [room] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(chatRoomsTable)
        .values({
          name,
          type,
          createdBy: request.user!.id,
        })
        .returning({
          id: chatRoomsTable.id,
          name: chatRoomsTable.name,
          type: chatRoomsTable.type,
          createdBy: chatRoomsTable.createdBy,
          createdAt: chatRoomsTable.createdAt,
        });
      if (type === "group") {
        await tx.insert(chatRoomMembersTable).values(memberIds.map((userId) => ({
          roomId: created!.id,
          userId,
        })));
      }
      return [created];
    });
    response.status(201).json({ room });
  } catch (error) {
    if (type === "channel" && typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      response.status(409).json({ error: "A channel with that name already exists." });
      return;
    }
    throw error;
  }
});

router.get("/chat/rooms/:id/messages", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const roomId = parseId(request.params.id);
  if (!roomId || !await userCanAccessRoom(roomId, request.user!.id)) {
    response.status(404).json({ error: "Chat room not found." });
    return;
  }
  const messages = await db.select({
    id: chatRoomMessagesTable.id,
    senderUserId: chatRoomMessagesTable.senderUserId,
    senderName: usersTable.name,
    message: chatRoomMessagesTable.message,
    createdAt: chatRoomMessagesTable.createdAt,
  })
    .from(chatRoomMessagesTable)
    .innerJoin(usersTable, eq(chatRoomMessagesTable.senderUserId, usersTable.id))
    .where(eq(chatRoomMessagesTable.roomId, roomId))
    .orderBy(desc(chatRoomMessagesTable.createdAt), desc(chatRoomMessagesTable.id))
    .limit(100);
  response.json({ messages: messages.reverse() });
});

router.post("/chat/rooms/:id/messages", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const roomId = parseId(request.params.id);
  const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
  if (!roomId || !message || message.length > MAX_ROOM_MESSAGE_LENGTH) {
    response.status(400).json({ error: `Enter a message of 1 to ${MAX_ROOM_MESSAGE_LENGTH} characters.` });
    return;
  }
  if (!await userCanAccessRoom(roomId, request.user!.id)) {
    response.status(404).json({ error: "Chat room not found." });
    return;
  }
  const [savedMessage] = await db.insert(chatRoomMessagesTable)
    .values({ roomId, senderUserId: request.user!.id, message })
    .returning({
      id: chatRoomMessagesTable.id,
      senderUserId: chatRoomMessagesTable.senderUserId,
      message: chatRoomMessagesTable.message,
      createdAt: chatRoomMessagesTable.createdAt,
    });
  const responseMessage = { ...savedMessage, senderName: request.user!.name };
  await broadcastRoomMessage(roomId, responseMessage);
  response.status(201).json(responseMessage);
});

interface ChatConnection {
  userId: number;
  sessionToken: string;
  lastMessageId: number;
  callKey?: string;
}

interface RoomMessagePayload {
  id: number;
  senderUserId: number;
  senderName: string;
  message: string;
  createdAt: Date;
}

interface ClientMessage {
  type: string;
  userId?: unknown;
  recipientUserId?: unknown;
  message?: unknown;
  roomType?: unknown;
  roomId?: unknown;
  callId?: unknown;
  mediaType?: unknown;
  targetUserId?: unknown;
  payload?: unknown;
}

const connections = new Map<WebSocket, ChatConnection>();
interface ActiveCall {
  id: string;
  roomType: "dm" | "room";
  roomId: number;
  mediaType: "audio" | "video";
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  participants: Set<number>;
  invites: Set<number>;
}
const activeCalls = new Map<string, ActiveCall>();
let pollingMessages = false;

interface ChatIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function isChatIceServer(value: unknown): value is ChatIceServer {
  if (typeof value !== "object" || value === null || !("urls" in value)) return false;
  const urls = value.urls;
  const urlList = typeof urls === "string" ? [urls] : Array.isArray(urls) ? urls : [];
  const validUrls = urlList.length > 0 && urlList.every((url: unknown) =>
    typeof url === "string" && /^(stun|stuns|turn|turns):/i.test(url),
  );
  const hasTurnUrl = urlList.some((url) => typeof url === "string" && /^(turn|turns):/i.test(url));
  const usernameValid = !("username" in value) || typeof value.username === "string";
  const credentialValid = !("credential" in value) || typeof value.credential === "string";
  const turnCredentialsValid = !hasTurnUrl || (
    "username" in value &&
    typeof value.username === "string" &&
    value.username.length > 0 &&
    "credential" in value &&
    typeof value.credential === "string" &&
    value.credential.length > 0
  );
  return validUrls && usernameValid && credentialValid && turnCredentialsValid;
}

function getIceServers(): ChatIceServer[] {
  const raw = process.env.CHAT_ICE_SERVERS;
  if (!raw) return [{ urls: "stun:stun.l.google.com:19302" }];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isChatIceServer)) {
    throw new Error("CHAT_ICE_SERVERS must be a non-empty JSON array of ICE server objects");
  }
  return parsed;
}

function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

async function broadcastRoomMessage(roomId: number, message: RoomMessagePayload): Promise<void> {
  const [room] = await db.select({ type: chatRoomsTable.type })
    .from(chatRoomsTable)
    .where(eq(chatRoomsTable.id, roomId))
    .limit(1);
  if (!room) return;
  const members = room.type === "channel"
    ? undefined
    : new Set((await db.select({ userId: chatRoomMembersTable.userId })
      .from(chatRoomMembersTable)
      .where(eq(chatRoomMembersTable.roomId, roomId)))
      .map((member) => member.userId));
  for (const [socket, connection] of connections) {
    if (!members || members.has(connection.userId)) {
      sendJson(socket, { type: "room_message", roomId, message });
    }
  }
}

function sendError(socket: WebSocket, error: string): void {
  sendJson(socket, { type: "error", error });
}

function sendCallError(socket: WebSocket, error: string): void {
  sendJson(socket, { type: "call_error", error });
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.headers.cookie
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix))
    ?.slice(prefix.length);
}

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404 | 500): void {
  const reason = status === 401 ? "Unauthorized"
    : status === 403 ? "Forbidden"
      : status === 404 ? "Not Found"
        : "Internal Server Error";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

async function updatePresence(userId: number): Promise<void> {
  await db.insert(chatPresenceTable)
    .values({ userId, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: chatPresenceTable.userId,
      set: { lastSeenAt: new Date() },
    });
}

async function sendUsers(socket: WebSocket, userId: number): Promise<void> {
  const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
  const users = await db.select({
    id: usersTable.id,
    name: usersTable.name,
    lastSeenAt: chatPresenceTable.lastSeenAt,
  })
    .from(usersTable)
    .leftJoin(chatPresenceTable, eq(usersTable.id, chatPresenceTable.userId))
    .where(or(
      eq(usersTable.role, "staff"),
      eq(usersTable.role, "admin"),
    ))
    .orderBy(usersTable.name);
  sendJson(socket, {
    type: "users",
    users: users
      .filter((user) => user.id !== userId)
      .map(({ lastSeenAt, ...user }) => ({
        ...user,
        online: lastSeenAt !== null && lastSeenAt > onlineSince,
      })),
  });
}

async function staffUserExists(userId: number): Promise<boolean> {
  const [user] = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.id, userId),
      or(eq(usersTable.role, "staff"), eq(usersTable.role, "admin")),
    ))
    .limit(1);
  return Boolean(user);
}

function findCallById(callId: string): [string, ActiveCall] | undefined {
  for (const entry of activeCalls) {
    if (entry[1].id === callId) return entry;
  }
  return undefined;
}

function sendToUser(userId: number, event: object): void {
  for (const [client, connection] of connections) {
    if (connection.userId === userId) sendJson(client, event);
  }
}

function removeFromCall(socket: WebSocket, connection: ChatConnection): void {
  const callKey = connection.callKey;
  if (!callKey) return;
  connection.callKey = undefined;
  const call = activeCalls.get(callKey);
  if (!call) return;
  call.participants.delete(connection.userId);
  call.invites.delete(connection.userId);
  for (const [client, other] of connections) {
    if (client !== socket && other.callKey === callKey) {
      sendJson(client, { type: "call_user_left", callId: call.id, userId: connection.userId });
    }
  }
  if (call.participants.size === 0) {
    for (const userId of call.invites) {
      sendToUser(userId, { type: "call_ended", callId: call.id });
    }
    activeCalls.delete(callKey);
  }
}

async function handleCallMessage(
  socket: WebSocket,
  connection: ChatConnection,
  message: ClientMessage,
  userName: string,
): Promise<boolean> {
  if (!message.type.startsWith("call_")) return false;

  if (message.type === "call_start") {
    const mediaType = message.mediaType;
    const roomType = message.roomType;
    const roomId = parseId(message.roomId);
    if ((mediaType !== "audio" && mediaType !== "video") || !roomId || (roomType !== "dm" && roomType !== "room")) {
      sendCallError(socket, "Choose a valid call type and conversation.");
      return true;
    }

    let callKey: string;
    let inviteUserIds: number[];
    if (roomType === "dm") {
      if (roomId === connection.userId || !await staffUserExists(roomId)) {
        sendCallError(socket, "That staff member could not be found.");
        return true;
      }
      callKey = `dm:${Math.min(roomId, connection.userId)}:${Math.max(roomId, connection.userId)}`;
      inviteUserIds = [roomId];
    } else {
      if (!await userCanAccessRoom(roomId, connection.userId)) {
        sendCallError(socket, "Chat room not found.");
        return true;
      }
      callKey = `room:${roomId}`;
      const room = await db.select({ type: chatRoomsTable.type })
        .from(chatRoomsTable)
        .where(eq(chatRoomsTable.id, roomId))
        .limit(1);
      const memberRows = room[0]?.type === "group"
        ? await db.select({ userId: chatRoomMembersTable.userId })
          .from(chatRoomMembersTable)
          .where(eq(chatRoomMembersTable.roomId, roomId))
        : await db.select({ id: usersTable.id })
          .from(usersTable)
          .where(or(eq(usersTable.role, "staff"), eq(usersTable.role, "admin")));
      inviteUserIds = memberRows.map((member) => "userId" in member ? member.userId : member.id);
    }

    if (connection.callKey) {
      sendCallError(socket, "Leave your current call before starting another.");
      return true;
    }
    if (socket.readyState !== WebSocket.OPEN) return true;
    let call = activeCalls.get(callKey);
    if (call) {
      sendCallError(socket, "A call is already active in this conversation.");
      return true;
    }
    let iceServers: ChatIceServer[];
    try {
      iceServers = getIceServers();
    } catch (error) {
      logger.error({ err: error }, "Invalid audio/video ICE server configuration");
      sendCallError(socket, "Audio and video calling are not configured correctly.");
      return true;
    }
    call = {
      id: randomUUID(),
      roomType,
      roomId,
      mediaType,
      iceServers,
      participants: new Set([connection.userId]),
      invites: new Set(inviteUserIds.filter((id) => id !== connection.userId)),
    };
    activeCalls.set(callKey, call);
    connection.callKey = callKey;
    sendJson(socket, { type: "call_started", callId: call.id, roomType, roomId, mediaType, iceServers: call.iceServers });
    for (const userId of call.invites) {
      sendToUser(userId, {
        type: "call_invite",
        callId: call.id,
        callerUserId: connection.userId,
        callerName: userName,
        roomType,
        roomId,
        mediaType,
        iceServers: call.iceServers,
      });
    }
    return true;
  }

  const callId = typeof message.callId === "string" ? message.callId : "";
  const foundCall = findCallById(callId);
  if (!foundCall) {
    sendCallError(socket, "This call is no longer available.");
    return true;
  }
  const [callKey, call] = foundCall;

  if (message.type === "call_accept") {
    if (!call.invites.has(connection.userId) || connection.callKey) {
      sendCallError(socket, "You are not invited to this call.");
      return true;
    }
    if (call.participants.size >= MAX_CALL_PARTICIPANTS) {
      sendCallError(socket, `Calls are limited to ${MAX_CALL_PARTICIPANTS} participants.`);
      return true;
    }
    call.invites.delete(connection.userId);
    call.participants.add(connection.userId);
    connection.callKey = callKey;
    const participants = [...call.participants]
      .filter((userId) => userId !== connection.userId);
    const names = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(inArray(usersTable.id, participants));
    sendJson(socket, {
      type: "call_joined",
      callId,
      mediaType: call.mediaType,
      iceServers: call.iceServers,
      participants: names,
    });
    for (const userId of participants) {
      sendToUser(userId, {
        type: "call_user_joined",
        callId,
        userId: connection.userId,
        userName,
      });
    }
    return true;
  }

  if (message.type === "call_reject") {
    if (call.invites.delete(connection.userId)) {
      for (const userId of call.participants) {
        sendToUser(userId, { type: "call_invite_rejected", callId, userId: connection.userId });
      }
    }
    return true;
  }

  if (message.type === "call_signal") {
    const targetUserId = parseId(message.targetUserId);
    if (
      !targetUserId ||
      !call.participants.has(connection.userId) ||
      !call.participants.has(targetUserId) ||
      connection.callKey !== callKey ||
      message.payload === undefined ||
      JSON.stringify(message.payload).length > 24_000
    ) {
      sendCallError(socket, "Invalid call signal.");
      return true;
    }
    sendToUser(targetUserId, {
      type: "call_signal",
      callId,
      fromUserId: connection.userId,
      payload: message.payload,
    });
    return true;
  }

  if (message.type === "call_leave") {
    if (connection.callKey === callKey) removeFromCall(socket, connection);
    return true;
  }

  sendCallError(socket, "Unknown call action.");
  return true;
}

async function handleClientMessage(socket: WebSocket, connection: ChatConnection, raw: RawData): Promise<void> {
  const user = await loadStaffUserFromSessionToken(connection.sessionToken);
  if (!user || user.id !== connection.userId) {
    socket.close(1008, "Sign in with GitHub to use chat");
    connections.delete(socket);
    return;
  }

  let message: unknown;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    sendError(socket, "Chat message must be valid JSON");
    return;
  }
  if (!isClientMessage(message)) {
    sendError(socket, "Chat message is invalid");
    return;
  }

  if (await handleCallMessage(socket, connection, message, user.name)) return;

  if (message.type === "presence" || message.type === "users") {
    if (message.type === "presence") await updatePresence(connection.userId);
    await sendUsers(socket, connection.userId);
    return;
  }

  if (message.type === "history") {
    const targetUserId = message.userId;
    if (!Number.isSafeInteger(targetUserId) || Number(targetUserId) <= 0 || Number(targetUserId) === connection.userId) {
      sendError(socket, "Choose a valid staff member");
      return;
    }
    const peerUserId = Number(targetUserId);
    if (!await staffUserExists(peerUserId)) {
      sendError(socket, "That staff member could not be found");
      return;
    }
    const history = await db.select({
      id: chatMessagesTable.id,
      senderUserId: chatMessagesTable.senderUserId,
      recipientUserId: chatMessagesTable.recipientUserId,
      message: chatMessagesTable.message,
      createdAt: chatMessagesTable.createdAt,
    })
      .from(chatMessagesTable)
      .where(or(
        and(
          eq(chatMessagesTable.senderUserId, connection.userId),
          eq(chatMessagesTable.recipientUserId, peerUserId),
        ),
        and(
          eq(chatMessagesTable.senderUserId, peerUserId),
          eq(chatMessagesTable.recipientUserId, connection.userId),
        ),
      ))
      .orderBy(desc(chatMessagesTable.createdAt), desc(chatMessagesTable.id))
      .limit(100);
    sendJson(socket, { type: "history", userId: peerUserId, messages: history.reverse() });
    return;
  }

  if (message.type === "send") {
    const recipientUserId = message.recipientUserId;
    const text = typeof message.message === "string" ? message.message.trim() : "";
    if (!Number.isSafeInteger(recipientUserId) || Number(recipientUserId) <= 0 || Number(recipientUserId) === connection.userId) {
      sendError(socket, "Choose a valid staff member");
      return;
    }
    if (!text || text.length > MAX_MESSAGE_LENGTH) {
      sendError(socket, `Messages must contain 1 to ${MAX_MESSAGE_LENGTH} characters`);
      return;
    }

    const peerUserId = Number(recipientUserId);
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
    const [recipient] = await db.select({ id: usersTable.id })
      .from(chatPresenceTable)
      .innerJoin(usersTable, eq(usersTable.id, chatPresenceTable.userId))
      .where(and(
        eq(usersTable.id, peerUserId),
        gt(chatPresenceTable.lastSeenAt, onlineSince),
        or(eq(usersTable.role, "staff"), eq(usersTable.role, "admin")),
      ))
      .limit(1);
    if (!recipient) {
      sendError(socket, "That staff member is no longer online");
      await sendUsers(socket, connection.userId);
      return;
    }

    const [savedMessage] = await db.insert(chatMessagesTable)
      .values({
        senderUserId: connection.userId,
        recipientUserId: peerUserId,
        message: text,
      })
      .returning({
        id: chatMessagesTable.id,
        senderUserId: chatMessagesTable.senderUserId,
        recipientUserId: chatMessagesTable.recipientUserId,
        message: chatMessagesTable.message,
        createdAt: chatMessagesTable.createdAt,
      });

    for (const [client, clientConnection] of connections) {
      if (clientConnection.userId === connection.userId || clientConnection.userId === peerUserId) {
        clientConnection.lastMessageId = savedMessage.id;
        sendJson(client, { type: "message", message: savedMessage });
      }
    }
    return;
  }

  sendError(socket, "Unknown chat action");
}

async function pollMessages(): Promise<void> {
  if (pollingMessages || connections.size === 0) return;
  pollingMessages = true;
  try {
    const activeConnections = [...connections.entries()]
      .filter(([socket]) => socket.readyState === WebSocket.OPEN);
    if (activeConnections.length === 0) return;

    const oldestCursor = Math.min(...activeConnections.map(([, connection]) => connection.lastMessageId));
    const newMessages = await db.select({
      id: chatMessagesTable.id,
      senderUserId: chatMessagesTable.senderUserId,
      recipientUserId: chatMessagesTable.recipientUserId,
      message: chatMessagesTable.message,
      createdAt: chatMessagesTable.createdAt,
    })
      .from(chatMessagesTable)
      .where(gt(chatMessagesTable.id, oldestCursor))
      .orderBy(asc(chatMessagesTable.id))
      .limit(500);

    for (const message of newMessages) {
      for (const [socket, connection] of activeConnections) {
        if (message.id <= connection.lastMessageId) continue;
        if (message.senderUserId === connection.userId || message.recipientUserId === connection.userId) {
          sendJson(socket, { type: "message", message });
        }
        connection.lastMessageId = message.id;
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Unable to deliver chat messages over WebSocket");
  } finally {
    pollingMessages = false;
  }
}

export function attachChatWebSocket(server: Server): void {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  const pollInterval = setInterval(() => void pollMessages(), 1500);
  pollInterval.unref();

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (requestUrl.pathname !== CHAT_SOCKET_PATH) {
        rejectUpgrade(socket, 404);
        return;
      }
      const origin = request.headers.origin;
      if (!origin || !isAllowedOrigin(origin)) {
        rejectUpgrade(socket, 403);
        return;
      }

      const sessionToken = cookieValue(request, SESSION_COOKIE);
      const user = await loadStaffUserFromSessionToken(sessionToken);
      if (!sessionToken || !user) {
        rejectUpgrade(socket, 401);
        return;
      }

      const [latestMessage] = await db.select({ id: chatMessagesTable.id })
        .from(chatMessagesTable)
        .orderBy(desc(chatMessagesTable.id))
        .limit(1);
      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        const connection = {
          userId: user.id,
          sessionToken,
          lastMessageId: latestMessage?.id ?? 0,
        };
        connections.set(client, connection);
        client.on("message", (data) => {
          void handleClientMessage(client, connection, data).catch((error: unknown) => {
            logger.error({ err: error, userId: user.id }, "Unable to process chat WebSocket message");
            sendError(client, "Unable to process that chat request");
          });
        });
        client.on("close", () => {
          removeFromCall(client, connection);
          connections.delete(client);
        });
        client.on("error", (error) => {
          logger.warn({ err: error, userId: user.id }, "Chat WebSocket connection error");
          removeFromCall(client, connection);
          connections.delete(client);
        });
        void (async () => {
          await updatePresence(user.id);
          sendJson(client, { type: "ready", userId: user.id });
          await sendUsers(client, user.id);
        })().catch((error: unknown) => {
          logger.error({ err: error, userId: user.id }, "Unable to initialize chat WebSocket");
          client.close(1011, "Unable to initialize chat");
        });
      });
    })().catch((error: unknown) => {
      logger.error({ err: error }, "Unable to authenticate chat WebSocket");
      if (!socket.destroyed) rejectUpgrade(socket, 500);
    });
  });
}

export default router;
