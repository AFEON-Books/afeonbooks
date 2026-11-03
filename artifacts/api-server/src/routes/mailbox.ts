import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, zohoMailConnectionsTable, zohoMailOAuthStatesTable } from "@workspace/db";
import { z } from "zod";
import { hashSessionToken, requireRole, requireUser } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const MAIL_UNLOCK_MS = 30 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const MAIL_SCOPES = [
  "ZohoMail.accounts.READ",
  "ZohoMail.folders.READ",
  "ZohoMail.messages.READ",
  "ZohoMail.messages.CREATE",
  "ZohoMail.messages.UPDATE",
  "ZohoMail.messages.DELETE",
].join(",");
const accountIdSchema = z.string().regex(/^\d+$/);
const listQuerySchema = z.object({
  folderId: accountIdSchema,
  start: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const inlineImageQuerySchema = z.object({
  na: accountIdSchema,
  nmsgId: accountIdSchema,
  f: z.string().regex(/^[A-Za-z0-9_-]{1,80}\.(?:png|jpe?g|gif|webp|avif)$/i),
  mode: z.literal("inline"),
  cid: z.string().regex(/^[A-Za-z0-9._@+-]{1,256}$/),
});
const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  start: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const sendBodySchema = z.object({
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  replyTo: z.string().email().optional(),
  subject: z.string().trim().min(1).max(998),
  html: z.string().max(80_000),
});
const actionBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }),
  z.object({ action: z.literal("unread") }),
  z.object({ action: z.literal("archive") }),
  z.object({ action: z.literal("flag"), flag: z.enum(["info", "important", "followup", "flag_not_set"]) }),
  z.object({ action: z.literal("move"), destinationFolderId: accountIdSchema }),
  z.object({ action: z.literal("delete") }),
]);

function getEncryptionKey(): Buffer {
  const encoded = process.env.MAIL_TOKEN_ENCRYPTION_KEY;
  const key = encoded ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error("MAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptToken(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Stored Zoho Mail credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function getAccountsUrl(path: string): URL {
  const accountsUrl = process.env.ZOHO_MAILBOX_ACCOUNTS_URL || process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
  return new URL(path, `${accountsUrl.replace(/\/+$/, "")}/`);
}

function getMailApiUrl(path: string): URL {
  const mailApiUrl = process.env.ZOHO_MAILBOX_API_URL || process.env.ZOHO_MAIL_API_URL || "https://mail.zoho.com";
  return new URL(path, `${mailApiUrl.replace(/\/+$/, "")}/`);
}

function getMailboxOAuthCredentials(): { clientId?: string; clientSecret?: string } {
  return {
    clientId: process.env.ZOHO_MAILBOX_CLIENT_ID || process.env.ZOHO_MAIL_CLIENT_ID || process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_MAILBOX_CLIENT_SECRET || process.env.ZOHO_MAIL_CLIENT_SECRET || process.env.ZOHO_CLIENT_SECRET,
  };
}

function getMailboxRedirectUri(): string {
  return process.env.ZOHO_MAILBOX_OAUTH_REDIRECT_URI
    || process.env.ZOHO_MAIL_OAUTH_REDIRECT_URI
    || "https://api.afeonbooks.com/api/mail/auth/callback";
}

function getCurrentSessionHash(request: Request): string | undefined {
  const sessionToken = request.cookies?.afeonbooks_session;
  return typeof sessionToken === "string" && sessionToken ? hashSessionToken(sessionToken) : undefined;
}

function requireMailboxOrigin(request: Request, response: Response, next: NextFunction): void {
  const path = new URL(request.originalUrl, "https://api.afeonbooks.com").pathname;
  if (path === "/api/mail/auth/callback") {
    next();
    return;
  }
  const origin = request.get("origin");
  const referer = request.get("referer");
  let requestOrigin = origin;
  if (!requestOrigin && referer) {
    try { requestOrigin = new URL(referer).origin; } catch {}
  }
  const allowed = requestOrigin === "https://mailsystem.afeonbooks.com" || (
    process.env.NODE_ENV !== "production" && requestOrigin !== undefined && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)
  );
  if (!allowed) {
    response.status(403).json({ error: "Mailbox requests must come from the mailsystem application." });
    return;
  }
  next();
}

async function getMailboxConnection(request: Request) {
  const sessionTokenHash = getCurrentSessionHash(request);
  if (!request.user || !sessionTokenHash) return undefined;
  const [connection] = await db.select().from(zohoMailConnectionsTable).where(and(
    eq(zohoMailConnectionsTable.userId, request.user.id),
    eq(zohoMailConnectionsTable.sessionTokenHash, sessionTokenHash),
    gt(zohoMailConnectionsTable.unlockedUntil, new Date()),
  )).limit(1);
  return connection;
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getMailboxOAuthCredentials();
  if (!clientId || !clientSecret) throw new Error("Zoho Mail OAuth is not configured");
  const response = await fetch(getAccountsUrl("/oauth/v2/token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15000),
  });
  const body: unknown = await response.json().catch(() => null);
  const accessToken = body && typeof body === "object" && "access_token" in body && typeof body.access_token === "string" ? body.access_token : "";
  if (!response.ok || !accessToken) {
    const providerError = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : undefined;
    logger.warn({ httpStatus: response.status, providerError }, "Zoho Mail access-token refresh failed");
    const message = providerError === "invalid_client"
      ? "Zoho rejected the mailbox OAuth client. Verify ZOHO_MAILBOX_CLIENT_ID and ZOHO_MAILBOX_CLIENT_SECRET in Render match the Zoho client used for mailbox authorization."
      : providerError === "invalid_grant"
        ? "Zoho revoked or expired this mailbox authorization. Lock the mailbox, then connect Zoho again using the configured mailbox OAuth client."
        : "Zoho could not refresh the mailbox authorization. Check the Render API logs for the Zoho error code; if it is invalid_grant, lock the mailbox and connect Zoho again.";
    const error = new Error(message);
    Object.assign(error, { status: 401, publicMessage: error.message });
    throw error;
  }
  return accessToken;
}

async function getZohoResponse(connection: NonNullable<Awaited<ReturnType<typeof getMailboxConnection>>>, path: string, init?: RequestInit): Promise<unknown> {
  const accessToken = await getAccessToken(decryptToken(connection.encryptedRefreshToken));
  const response = await fetch(getMailApiUrl(`/api/accounts/${encodeURIComponent(connection.accountId)}${path}`), {
    ...init,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(20000),
  });
  const payload: unknown = await response.json().catch(() => null);
  const providerStatus = payload && typeof payload === "object" && "status" in payload ? payload.status : undefined;
  const providerCode = providerStatus && typeof providerStatus === "object" && "code" in providerStatus ? Number(providerStatus.code) : undefined;
  if (!response.ok || (providerCode !== undefined && Number.isFinite(providerCode) && providerCode !== 200)) {
    logger.warn({ httpStatus: response.status, providerCode: Number.isFinite(providerCode) ? providerCode : undefined }, "Zoho Mail API rejected a mailbox request");
    const reason = Number.isFinite(providerCode) ? ` (Zoho code ${providerCode})` : ` (HTTP ${response.status})`;
    const error = new Error(`Zoho Mail rejected that action${reason}. Please refresh and try again.`);
    Object.assign(error, { status: 502, publicMessage: error.message });
    throw error;
  }
  return payload;
}

function requireMailbox(request: Request, response: Response, next: NextFunction): void {
  void getMailboxConnection(request).then((connection) => {
    if (!connection) {
      response.status(423).json({ error: "Unlock the mailbox with Zoho to continue." });
      return;
    }
    request.mailboxConnection = connection;
    next();
  }).catch(next);
}

declare global {
  namespace Express {
    interface Request {
      mailboxConnection?: typeof zohoMailConnectionsTable.$inferSelect;
    }
  }
}

router.use("/mail", requireMailboxOrigin);

router.get("/mail/session", requireUser, requireRole("staff", "admin"), async (request, response): Promise<void> => {
  const connection = await getMailboxConnection(request);
  response.setHeader("Cache-Control", "no-store");
  response.json(connection ? { unlocked: true, emailAddress: connection.emailAddress, unlockedUntil: connection.unlockedUntil } : { unlocked: false });
});

router.get("/mail/auth/start", requireUser, requireRole("staff", "admin"), async (request, response): Promise<void> => {
  const { clientId, clientSecret } = getMailboxOAuthCredentials();
  const redirectUri = getMailboxRedirectUri();
  const sessionTokenHash = getCurrentSessionHash(request);
  if (!clientId || !clientSecret || !sessionTokenHash) {
    response.status(503).json({ error: "Zoho Mail is not configured for secure sign-in." });
    return;
  }
  try {
    getEncryptionKey();
  } catch {
    response.status(503).json({ error: "Zoho Mail encryption is not configured on the API server." });
    return;
  }
  const state = randomBytes(32).toString("base64url");
  await db.insert(zohoMailOAuthStatesTable).values({
    stateHash: hashSessionToken(state),
    userId: request.user!.id,
    sessionTokenHash,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });
  const authorizeUrl = getAccountsUrl("/oauth/v2/auth");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("scope", MAIL_SCOPES);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("access_type", "offline");
  authorizeUrl.searchParams.set("prompt", "consent");
  authorizeUrl.searchParams.set("state", state);
  response.setHeader("Cache-Control", "no-store");
  response.redirect(authorizeUrl.toString());
});

router.get("/mail/auth/callback", requireUser, requireRole("staff", "admin"), async (request, response): Promise<void> => {
  const appUrl = new URL("https://mailsystem.afeonbooks.com/");
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const state = typeof request.query.state === "string" ? request.query.state : "";
  const sessionTokenHash = getCurrentSessionHash(request);
  const providerError = typeof request.query.error === "string" ? request.query.error : "";
  if (providerError) {
    logger.warn({ providerError }, "Zoho Mail authorization was denied");
    appUrl.searchParams.set("mail_error", "authorization_denied");
    response.redirect(appUrl.toString());
    return;
  }
  if (!code || !state || !sessionTokenHash) {
    logger.warn({ hasCode: Boolean(code), hasState: Boolean(state), hasSession: Boolean(sessionTokenHash) }, "Zoho Mail callback was missing authorization state");
    appUrl.searchParams.set("mail_error", "invalid_callback");
    response.redirect(appUrl.toString());
    return;
  }
  const [oauthState] = await db.update(zohoMailOAuthStatesTable).set({ usedAt: new Date() }).where(and(
    eq(zohoMailOAuthStatesTable.stateHash, hashSessionToken(state)),
    eq(zohoMailOAuthStatesTable.userId, request.user!.id),
    eq(zohoMailOAuthStatesTable.sessionTokenHash, sessionTokenHash),
    isNull(zohoMailOAuthStatesTable.usedAt),
    gt(zohoMailOAuthStatesTable.expiresAt, new Date()),
  )).returning({ id: zohoMailOAuthStatesTable.id });
  if (!oauthState) {
    logger.warn({ userId: request.user!.id }, "Zoho Mail callback state did not match the current admin session");
    appUrl.searchParams.set("mail_error", "invalid_state");
    response.redirect(appUrl.toString());
    return;
  }
  let failureStage = "token_exchange";
  try {
    const { clientId, clientSecret } = getMailboxOAuthCredentials();
    if (!clientId || !clientSecret) throw new Error("Zoho Mail OAuth is not configured");
    const tokenResponse = await fetch(getAccountsUrl("/oauth/v2/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: getMailboxRedirectUri(),
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15000),
    });
    const tokenBody: unknown = await tokenResponse.json().catch(() => null);
    const accessToken = tokenBody && typeof tokenBody === "object" && "access_token" in tokenBody && typeof tokenBody.access_token === "string" ? tokenBody.access_token : "";
    const refreshToken = tokenBody && typeof tokenBody === "object" && "refresh_token" in tokenBody && typeof tokenBody.refresh_token === "string" ? tokenBody.refresh_token : "";
    if (!tokenResponse.ok || !accessToken || !refreshToken) throw new Error("Zoho authorization did not return valid credentials");

    failureStage = "mailbox_lookup";
    const accountsResponse = await fetch(getMailApiUrl("/api/accounts"), {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const accountsBody: unknown = await accountsResponse.json().catch(() => null);
    const accounts = accountsBody && typeof accountsBody === "object" && "data" in accountsBody && Array.isArray(accountsBody.data) ? accountsBody.data : [];
    const configuredAccountId = process.env.ZOHO_MAILBOX_ACCOUNT_ID;
    const configuredAddress = process.env.ZOHO_MAILBOX_AUTHENTICATED_USER?.toLowerCase();
    const account = accounts.find((value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const item = value as Record<string, unknown>;
      const id = String(item.accountId ?? item.accountid ?? item.zuid ?? "");
      const addresses = Array.isArray(item.emailAddress) ? item.emailAddress.map((entry) => {
        if (typeof entry === "string") return entry.toLowerCase();
        if (entry && typeof entry === "object" && "emailAddress" in entry && typeof entry.emailAddress === "string") return entry.emailAddress.toLowerCase();
        return "";
      }) : [];
      const primary = typeof item.mailboxAddress === "string" ? item.mailboxAddress.toLowerCase() : typeof item.primaryEmailAddress === "string" ? item.primaryEmailAddress.toLowerCase() : "";
      return configuredAccountId ? id === configuredAccountId : configuredAddress ? addresses.includes(configuredAddress) || primary === configuredAddress : accounts.length === 1;
    });
    if (!accountsResponse.ok || !account) throw new Error("Could not identify one authorized Zoho mailbox account");
    const accountRecord = account as Record<string, unknown>;
    const accountId = String(accountRecord.accountId ?? accountRecord.accountid ?? "");
    const emailAddresses = Array.isArray(accountRecord.emailAddress) ? accountRecord.emailAddress : [];
    const primaryAddress = emailAddresses.find((entry) => entry && typeof entry === "object" && "isAlias" in entry && entry.isAlias !== true) as Record<string, unknown> | undefined;
    const emailAddress = typeof primaryAddress?.emailAddress === "string"
      ? primaryAddress.emailAddress
      : typeof accountRecord.mailboxAddress === "string"
      ? accountRecord.mailboxAddress
      : typeof accountRecord.primaryEmailAddress === "string"
        ? accountRecord.primaryEmailAddress
        : typeof configuredAddress === "string" ? configuredAddress : "";
    if (!/^\d+$/.test(accountId) || !emailAddress) throw new Error("Zoho did not return a usable mailbox account");
    if (emailAddress.trim().toLowerCase() !== request.user!.email.trim().toLowerCase()) {
      logger.warn({ userId: request.user!.id }, "Error 403: Zoho Mail callback returned a mailbox that does not match the current user");
      await db.delete(zohoMailConnectionsTable).where(and(
        eq(zohoMailConnectionsTable.userId, request.user!.id),
        eq(zohoMailConnectionsTable.sessionTokenHash, sessionTokenHash),
      ));
      appUrl.searchParams.set("mail_error", "account_mismatch");
      response.setHeader("Cache-Control", "no-store");
      response.redirect(appUrl.toString());
      return;
    }

    failureStage = "save_connection";
    await db.insert(zohoMailConnectionsTable).values({
      userId: request.user!.id,
      accountId,
      emailAddress,
      encryptedRefreshToken: encryptToken(refreshToken),
      sessionTokenHash,
      unlockedUntil: new Date(Date.now() + MAIL_UNLOCK_MS),
    }).onConflictDoUpdate({
      target: zohoMailConnectionsTable.userId,
      set: {
        accountId,
        emailAddress,
        encryptedRefreshToken: encryptToken(refreshToken),
        sessionTokenHash,
        unlockedUntil: new Date(Date.now() + MAIL_UNLOCK_MS),
        updatedAt: new Date(),
      },
    });
    appUrl.searchParams.set("mail_connected", "1");
  } catch (error) {
    logger.error({ stage: failureStage, err: error }, "Zoho Mail OAuth callback failed");
    appUrl.searchParams.set("mail_error", "authorization_failed");
  }
  response.setHeader("Cache-Control", "no-store");
  response.redirect(appUrl.toString());
});

router.post("/mail/lock", requireUser, requireRole("staff", "admin"), async (request, response): Promise<void> => {
  const sessionTokenHash = getCurrentSessionHash(request);
  if (sessionTokenHash) {
    await db.delete(zohoMailConnectionsTable).where(and(
      eq(zohoMailConnectionsTable.userId, request.user!.id),
      eq(zohoMailConnectionsTable.sessionTokenHash, sessionTokenHash),
    ));
  }
  response.status(204).end();
});

router.get("/mail/folders", requireUser, requireRole("staff", "admin"), requireMailbox, async (request, response): Promise<void> => {
  response.setHeader("Cache-Control", "no-store");
  response.json(await getZohoResponse(request.mailboxConnection!, "/folders"));
});

router.get("/mail/messages", requireUser, requireRole("staff", "admin"), requireMailbox, async (request, response): Promise<void> => {
  const query = listQuerySchema.safeParse(request.query);
  if (!query.success) {
    response.status(400).json({ error: "Invalid mailbox query." });
    return;
  }
  const params = new URLSearchParams({ folderId: query.data.folderId, start: String(query.data.start), limit: String(query.data.limit), threadedMails: "false", includeto: "true" });
  response.setHeader("Cache-Control", "no-store");
  response.json(await getZohoResponse(request.mailboxConnection!, `/messages/view?${params}`));
});

router.get("/mail/search", requireUser, requireRole("staff", "admin"), requireMailbox, async (request, response): Promise<void> => {
  const query = searchQuerySchema.safeParse(request.query);
  if (!query.success) {
    response.status(400).json({ error: "Invalid search query." });
    return;
  }
  const params = new URLSearchParams({ searchKey: query.data.q, start: String(query.data.start), limit: String(query.data.limit), includeto: "true" });
  response.setHeader("Cache-Control", "no-store");
  response.json(await getZohoResponse(request.mailboxConnection!, `/messages/search?${params}`));
});

router.get("/mail/messages/:folderId/:messageId", requireUser, requireRole("staff", "admin"), requireMailbox, async (request, response): Promise<void> => {
  const folderId = accountIdSchema.safeParse(request.params.folderId);
  const messageId = accountIdSchema.safeParse(request.params.messageId);
  if (!folderId.success || !messageId.success) {
    response.status(400).json({ error: "Invalid message reference." });
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  response.json(await getZohoResponse(request.mailboxConnection!, `/folders/${folderId.data}/messages/${messageId.data}/content`));
});

router.get("/mail/messages/:folderId/:messageId/inline-image", requireUser, requireRole("staff", "admin"), requireMailbox, async (request, response): Promise<void> => {
  const folderId = accountIdSchema.safeParse(request.params.folderId);
  const messageId = accountIdSchema.safeParse(request.params.messageId);
  const query = inlineImageQuerySchema.safeParse(request.query);
  if (!folderId.success || !messageId.success || !query.success
    || query.data.na !== request.mailboxConnection!.accountId
    || query.data.nmsgId !== messageId.data) {
    response.status(400).json({ error: "Invalid inline image reference." });
    return;
  }

  const accessToken = await getAccessToken(decryptToken(request.mailboxConnection!.encryptedRefreshToken));
  const params = new URLSearchParams({
    na: request.mailboxConnection!.accountId,
    nmsgId: messageId.data,
    f: query.data.f,
    mode: "inline",
    cid: query.data.cid,
  });
  const upstream = await fetch(getMailApiUrl(`/mail/ImageDisplay?${params}`), {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const contentLength = Number(upstream.headers.get("content-length"));
  if (!upstream.ok || !INLINE_IMAGE_TYPES.has(contentType)
    || (Number.isFinite(contentLength) && contentLength > MAX_INLINE_IMAGE_BYTES)
    || !upstream.body) {
    logger.warn({ httpStatus: upstream.status, contentType, messageId: messageId.data }, "Zoho Mail inline image fetch failed");
    response.status(502).json({ error: "Zoho could not load this inline email image." });
    return;
  }

  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_INLINE_IMAGE_BYTES) {
      await reader.cancel();
      response.status(502).json({ error: "This inline email image is too large to display." });
      return;
    }
    chunks.push(value);
  }
  const image = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.json({ contentType, data: image.toString("base64") });
});

router.post("/mail/messages", requireUser, requireRole("staff", "admin"), requireMailbox, async (request, response): Promise<void> => {
  const body = sendBodySchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: "Invalid email content or recipient." });
    return;
  }
  const payload = {
    fromAddress: request.mailboxConnection!.emailAddress,
    toAddress: body.data.to.join(","),
    ccAddress: body.data.cc?.join(","),
    bccAddress: body.data.bcc?.join(","),
    replyTo: body.data.replyTo,
    subject: body.data.subject,
    content: body.data.html,
    mailFormat: "html",
  };
  response.setHeader("Cache-Control", "no-store");
  response.json(await getZohoResponse(request.mailboxConnection!, "/messages", { method: "POST", body: JSON.stringify(payload) }));
});

router.post("/mail/messages/:folderId/:messageId/reply", requireUser, requireRole("staff", "admin"), requireMailbox, async (request, response): Promise<void> => {
  const folderId = accountIdSchema.safeParse(request.params.folderId);
  const messageId = accountIdSchema.safeParse(request.params.messageId);
  const body = sendBodySchema.safeParse(request.body);
  if (!folderId.success || !messageId.success || !body.success || body.data.to.length !== 1) {
    response.status(400).json({ error: "A valid message and one reply recipient are required." });
    return;
  }
  const payload = {
    fromAddress: request.mailboxConnection!.emailAddress,
    toAddress: body.data.to[0],
    ccAddress: body.data.cc?.join(","),
    subject: body.data.subject,
    action: "Reply",
    content: body.data.html,
    mailFormat: "html",
  };
  response.setHeader("Cache-Control", "no-store");
  response.json(await getZohoResponse(request.mailboxConnection!, `/messages/${messageId.data}`, { method: "POST", body: JSON.stringify(payload) }));
});

router.post("/mail/messages/:folderId/:messageId/actions", requireUser, requireRole("staff", "admin"), requireMailbox, async (request, response): Promise<void> => {
  const folderId = accountIdSchema.safeParse(request.params.folderId);
  const messageId = accountIdSchema.safeParse(request.params.messageId);
  const body = actionBodySchema.safeParse(request.body);
  if (!folderId.success || !messageId.success || !body.success) {
    response.status(400).json({ error: "Invalid message action." });
    return;
  }
  const { action } = body.data;
  if (action === "delete") {
    response.setHeader("Cache-Control", "no-store");
    response.json(await getZohoResponse(request.mailboxConnection!, `/folders/${folderId.data}/messages/${messageId.data}`,
      { method: "DELETE" }));
    return;
  }
  const payload: Record<string, unknown> = {
    messageId: [messageId.data],
    isFolderSpecific: true,
    folderId: folderId.data,
  };
  if (action === "read") payload.mode = "markAsRead";
  if (action === "unread") payload.mode = "markAsUnread";
  if (action === "archive") payload.mode = "archiveMails";
  if (action === "flag") {
    payload.mode = "setFlag";
    payload.flagid = body.data.flag;
  }
  if (action === "move") {
    payload.mode = "moveMessage";
    payload.destfolderId = body.data.destinationFolderId;
  }
  response.setHeader("Cache-Control", "no-store");
  response.json(await getZohoResponse(request.mailboxConnection!, "/updatemessage", {
    method: "PUT",
    body: JSON.stringify(payload),
  }));
});

router.use((error: unknown, request: Request, response: Response, next: NextFunction): void => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : 500;
  const publicMessage = error && typeof error === "object" && "publicMessage" in error && typeof error.publicMessage === "string"
    ? error.publicMessage
    : "Mailbox request failed. Please try again; if it continues, contact an administrator.";
  logger.error({ err: error, method: request.method, status }, "Mailbox API request failed");
  response.status(status).json({ error: publicMessage });
});

export default router;
