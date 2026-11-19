import { createHmac, randomBytes } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { authRateLimitsTable, db, supportConversationsTable, supportMessagesTable, usersTable } from "@workspace/db";
import { hashSessionToken, requireStaffAccess, requireUser } from "../lib/auth";
import { isAllowedOrigin } from "../lib/origin";

const router: IRouter = Router();
const CUSTOMER_COOKIE = "afeonbooks_support_chat";
const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
const MAX_MESSAGE_LENGTH = 2_000;
const SESSION_ENDED_MESSAGE = "Thank you for chatting with AFEON Books. Your session has ended. If you have further questions, please start a new support chat.";
const RATE_WINDOW_MS = 15 * 60 * 1000;
let rateLimitCleanupAt = 0;

function customerCookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax" as const,
    domain: IS_PRODUCTION ? ".afeonbooks.com" : undefined,
    maxAge: 1000 * 60 * 60 * 24 * 180,
    path: "/api/support-chat",
  };
}

function requireAllowedOrigin(request: Request, response: Response): boolean {
  const origin = request.get("origin");
  if (!origin || !isAllowedOrigin(origin)) {
    response.status(403).json({ error: "Open customer support from the AFEON Books website." });
    return false;
  }
  return true;
}

async function consumeRateLimit(key: string, limit: number): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RATE_WINDOW_MS);
  const [bucket] = await db.insert(authRateLimitsTable)
    .values({ key, windowStartedAt: now, attempts: 1 })
    .onConflictDoUpdate({
      target: authRateLimitsTable.key,
      set: {
        attempts: sql`CASE WHEN ${authRateLimitsTable.windowStartedAt} <= ${cutoff} THEN 1 ELSE ${authRateLimitsTable.attempts} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${authRateLimitsTable.windowStartedAt} <= ${cutoff} THEN ${now} ELSE ${authRateLimitsTable.windowStartedAt} END`,
      },
    })
    .returning({ attempts: authRateLimitsTable.attempts });

  if (Date.now() >= rateLimitCleanupAt) {
    rateLimitCleanupAt = Date.now() + 60 * 60 * 1000;
    await db.delete(authRateLimitsTable)
      .where(sql`${authRateLimitsTable.windowStartedAt} < ${new Date(Date.now() - 24 * 60 * 60 * 1000)}`);
  }
  return (bucket?.attempts ?? limit + 1) <= limit;
}

function hashRateLimitIdentity(value: string): string {
  const pepper = process.env.AUTH_CODE_PEPPER || process.env.DATABASE_URL;
  if (!pepper) throw new Error("AUTH_CODE_PEPPER or DATABASE_URL must be configured");
  return createHmac("sha256", pepper).update(value).digest("hex");
}

async function findCustomerConversation(request: Request, response: Response) {
  const token = request.cookies?.[CUSTOMER_COOKIE];
  if (!token) {
    response.status(401).json({ error: "Start a support conversation first." });
    return undefined;
  }
  const [conversation] = await db.select()
    .from(supportConversationsTable)
    .where(eq(supportConversationsTable.customerTokenHash, hashSessionToken(token)))
    .limit(1);
  if (!conversation) {
    response.status(401).json({ error: "This support conversation has expired. Start a new one." });
    return undefined;
  }
  return conversation;
}

function parseConversationId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

router.use("/support-chat", (_request, response, next) => {
  response.setHeader("Cache-Control", "private, no-store");
  next();
});

router.post("/support-chat/session", async (request, response): Promise<void> => {
  if (!requireAllowedOrigin(request, response)) return;
  const existing = await findExistingConversation(request);
  if (existing) {
    if (existing.status === "open") {
      response.json({ conversationId: existing.id });
      return;
    }
    response.clearCookie(CUSTOMER_COOKIE, {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax",
      domain: IS_PRODUCTION ? ".afeonbooks.com" : undefined,
      path: "/api/support-chat",
    });
  }

  const ip = request.get("cf-connecting-ip") || request.socket.remoteAddress || "unknown";
  if (!await consumeRateLimit(`support-chat-session:${hashRateLimitIdentity(ip)}`, 8)) {
    response.status(429).json({ error: "Please wait before starting another support chat." });
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const [conversation] = await db.insert(supportConversationsTable)
    .values({ customerTokenHash: hashSessionToken(token) })
    .returning({ id: supportConversationsTable.id });
  if (!conversation) {
    response.status(500).json({ error: "Unable to start a support conversation." });
    return;
  }
  response.cookie(CUSTOMER_COOKIE, token, customerCookieOptions());
  response.status(201).json({ conversationId: conversation.id });
});

async function findExistingConversation(request: Request) {
  const token = request.cookies?.[CUSTOMER_COOKIE];
  if (!token) return undefined;
  const [conversation] = await db.select({
    id: supportConversationsTable.id,
    status: supportConversationsTable.status,
  })
    .from(supportConversationsTable)
    .where(eq(supportConversationsTable.customerTokenHash, hashSessionToken(token)))
    .limit(1);
  return conversation;
}

router.get("/support-chat/messages", async (request, response): Promise<void> => {
  const conversation = await findCustomerConversation(request, response);
  if (!conversation) return;
  const messages = await db.select({
    id: supportMessagesTable.id,
    senderType: supportMessagesTable.senderType,
    message: supportMessagesTable.message,
    createdAt: supportMessagesTable.createdAt,
  })
    .from(supportMessagesTable)
    .where(eq(supportMessagesTable.conversationId, conversation.id))
    .orderBy(desc(supportMessagesTable.createdAt), desc(supportMessagesTable.id))
    .limit(100);
  response.json({
    conversationId: conversation.id,
    status: conversation.status,
    messages: messages.reverse(),
  });
});

router.post("/support-chat/messages", async (request, response): Promise<void> => {
  if (!requireAllowedOrigin(request, response)) return;
  const conversation = await findCustomerConversation(request, response);
  if (!conversation) return;
  if (conversation.status === "closed") {
    response.status(409).json({ error: "This support session has ended." });
    return;
  }

  const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    response.status(400).json({ error: `Messages must contain 1 to ${MAX_MESSAGE_LENGTH} characters.` });
    return;
  }
  if (!await consumeRateLimit(`support-chat-message:${conversation.customerTokenHash}`, 30)) {
    response.status(429).json({ error: "You have sent several messages. Please wait a few minutes." });
    return;
  }

  const now = new Date();
  const [savedMessage] = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(supportMessagesTable)
      .values({
        conversationId: conversation.id,
        senderType: "customer",
        message,
      })
      .returning({
        id: supportMessagesTable.id,
        senderType: supportMessagesTable.senderType,
        message: supportMessagesTable.message,
        createdAt: supportMessagesTable.createdAt,
      });
    await tx.update(supportConversationsTable)
      .set({
        updatedAt: now,
        lastCustomerMessageAt: now,
      })
      .where(eq(supportConversationsTable.id, conversation.id));
    return [inserted];
  });
  response.status(201).json(savedMessage);
});

router.get("/support-chat/admin/conversations", requireUser, requireStaffAccess("staff", "admin"), async (_request, response): Promise<void> => {
  const conversations = await db.select({
    id: supportConversationsTable.id,
    status: supportConversationsTable.status,
    createdAt: supportConversationsTable.createdAt,
    updatedAt: supportConversationsTable.updatedAt,
    lastCustomerMessageAt: supportConversationsTable.lastCustomerMessageAt,
    lastStaffReadAt: supportConversationsTable.lastStaffReadAt,
  })
    .from(supportConversationsTable)
    .orderBy(desc(supportConversationsTable.updatedAt))
    .limit(200);
  response.json({
    conversations: conversations.map((conversation) => ({
      ...conversation,
      unread: Boolean(
        conversation.lastCustomerMessageAt &&
        (!conversation.lastStaffReadAt || conversation.lastCustomerMessageAt > conversation.lastStaffReadAt),
      ),
    })),
  });
});

router.get("/support-chat/admin/conversations/:id/messages", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const id = parseConversationId(request.params.id);
  if (!id) {
    response.status(400).json({ error: "Invalid support conversation." });
    return;
  }
  const [conversation] = await db.update(supportConversationsTable)
    .set({ lastStaffReadAt: new Date() })
    .where(eq(supportConversationsTable.id, id))
    .returning({
      id: supportConversationsTable.id,
      status: supportConversationsTable.status,
    });
  if (!conversation) {
    response.status(404).json({ error: "Support conversation not found." });
    return;
  }
  const messages = await db.select({
    id: supportMessagesTable.id,
    senderType: supportMessagesTable.senderType,
    senderUserId: supportMessagesTable.senderUserId,
    senderName: usersTable.name,
    message: supportMessagesTable.message,
    createdAt: supportMessagesTable.createdAt,
  })
    .from(supportMessagesTable)
    .leftJoin(usersTable, eq(supportMessagesTable.senderUserId, usersTable.id))
    .where(eq(supportMessagesTable.conversationId, id))
    .orderBy(desc(supportMessagesTable.createdAt), desc(supportMessagesTable.id))
    .limit(100);
  response.json({ conversation, messages: messages.reverse() });
});

router.post("/support-chat/admin/conversations/:id/messages", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const id = parseConversationId(request.params.id);
  const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
  if (!id || !message || message.length > MAX_MESSAGE_LENGTH) {
    response.status(400).json({ error: `Choose a conversation and enter 1 to ${MAX_MESSAGE_LENGTH} characters.` });
    return;
  }
  const [conversation] = await db.select({
    id: supportConversationsTable.id,
    status: supportConversationsTable.status,
  })
    .from(supportConversationsTable)
    .where(eq(supportConversationsTable.id, id))
    .limit(1);
  if (!conversation) {
    response.status(404).json({ error: "Support conversation not found." });
    return;
  }
  if (conversation.status === "closed") {
    response.status(409).json({ error: "This support session has ended." });
    return;
  }
  const [savedMessage] = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(supportMessagesTable)
      .values({
        conversationId: id,
        senderType: "staff",
        senderUserId: request.user!.id,
        message,
      })
      .returning({
        id: supportMessagesTable.id,
        senderType: supportMessagesTable.senderType,
        senderUserId: supportMessagesTable.senderUserId,
        message: supportMessagesTable.message,
        createdAt: supportMessagesTable.createdAt,
      });
    await tx.update(supportConversationsTable)
      .set({ updatedAt: new Date() })
      .where(eq(supportConversationsTable.id, id));
    return [inserted];
  });
  response.status(201).json(savedMessage);
});

router.patch("/support-chat/admin/conversations/:id", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const id = parseConversationId(request.params.id);
  const status = request.body?.status;
  if (!id || (status !== "open" && status !== "closed")) {
    response.status(400).json({ error: "Choose a valid support conversation status." });
    return;
  }
  const [conversation] = await db.transaction(async (tx) => {
    const [current] = await tx.select({
      id: supportConversationsTable.id,
      status: supportConversationsTable.status,
    })
      .from(supportConversationsTable)
      .where(eq(supportConversationsTable.id, id))
      .limit(1);
    if (!current) return [];

    const now = new Date();
    let endedMessage: {
      id: number;
      senderType: string;
      senderUserId: number | null;
      message: string;
      createdAt: Date;
    } | undefined;
    if (status === "closed" && current.status !== "closed") {
      const [inserted] = await tx.insert(supportMessagesTable)
        .values({
          conversationId: id,
          senderType: "staff",
          senderUserId: request.user!.id,
          message: SESSION_ENDED_MESSAGE,
        })
        .returning({
          id: supportMessagesTable.id,
          senderType: supportMessagesTable.senderType,
          senderUserId: supportMessagesTable.senderUserId,
          message: supportMessagesTable.message,
          createdAt: supportMessagesTable.createdAt,
        });
      endedMessage = inserted;
    }
    const [updated] = await tx.update(supportConversationsTable)
      .set({ status, updatedAt: now })
      .where(eq(supportConversationsTable.id, id))
      .returning({ id: supportConversationsTable.id, status: supportConversationsTable.status });
    return [{ conversation: updated, endedMessage }];
  });
  if (!conversation) {
    response.status(404).json({ error: "Support conversation not found." });
    return;
  }
  response.json(conversation);
});

export default router;
