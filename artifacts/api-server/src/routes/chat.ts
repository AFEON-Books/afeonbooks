import { type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { chatMessagesTable, chatPresenceTable, db, usersTable } from "@workspace/db";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { loadStaffUserFromSessionToken, requireStaffAccess, requireUser } from "../lib/auth";
import { isAllowedOrigin } from "../lib/origin";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const ONLINE_WINDOW_MS = 75_000;
const MAX_MESSAGE_LENGTH = 2_000;
const SESSION_COOKIE = "afeonbooks_session";
const CHAT_SOCKET_PATH = "/api/chat/socket";

router.use("/chat", (_request, response, next) => {
  response.setHeader("Cache-Control", "private, no-store");
  next();
});

router.get("/chat/session", requireUser, requireStaffAccess("staff", "admin"), (request, response) => {
  response.json({ userId: request.user!.id });
});

interface ChatConnection {
  userId: number;
  sessionToken: string;
  lastMessageId: number;
}

interface ClientMessage {
  type: string;
  userId?: unknown;
  recipientUserId?: unknown;
  message?: unknown;
}

const connections = new Map<WebSocket, ChatConnection>();
let pollingMessages = false;

function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function sendError(socket: WebSocket, error: string): void {
  sendJson(socket, { type: "error", error });
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
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
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
        client.on("close", () => connections.delete(client));
        client.on("error", (error) => {
          logger.warn({ err: error, userId: user.id }, "Chat WebSocket connection error");
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
