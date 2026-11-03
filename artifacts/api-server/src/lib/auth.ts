import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authTokensTable, db, sessionsTable, usersTable, zohoMailConnectionsTable, type UserRow } from "@workspace/db";
import { logger } from "./logger";
import { verifyCloudflareAccessAssertion } from "./cloudflare-access";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "afeonbooks_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
const SESSION_COOKIE_DOMAIN = ".afeonbooks.com";
const PRODUCTION_ORIGINS = new Set([
  "https://afeonbooks.com",
  "https://authn.afeonbooks.com",
  "https://source.afeonbooks.com",
]);

declare global {
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionCookieDomain(request: Request): string | undefined {
  const origin = request.get("origin");
  return IS_PRODUCTION || (origin !== undefined && PRODUCTION_ORIGINS.has(origin))
    ? SESSION_COOKIE_DOMAIN
    : undefined;
}

export async function createAuthToken(userId: number, type: "verify_email" | "reset_password", ttlMs: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.delete(authTokensTable).where(and(eq(authTokensTable.userId, userId), eq(authTokensTable.type, type)));
  await db.insert(authTokensTable).values({
    userId,
    tokenHash: hashSessionToken(token),
    type,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

export async function consumeAuthToken(token: string, type: "verify_email" | "reset_password"): Promise<number | undefined> {
  const [found] = await db
    .select()
    .from(authTokensTable)
    .where(and(eq(authTokensTable.tokenHash, hashSessionToken(token)), eq(authTokensTable.type, type), isNull(authTokensTable.usedAt), gt(authTokensTable.expiresAt, new Date())))
    .limit(1);
  if (!found) return undefined;
  const [used] = await db
    .update(authTokensTable)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokensTable.id, found.id), isNull(authTokensTable.usedAt)))
    .returning({ userId: authTokensTable.userId });
  return used?.userId;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, "hex");
  return expected.length === derivedKey.length && timingSafeEqual(expected, derivedKey);
}

export function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, name: user.name, role: user.role ?? "customer", createdAt: user.createdAt.toISOString() };
}

export async function createSession(userId: number, request: Request, response: Response): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessionsTable).values({
    tokenHash: hashSessionToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  const domain = sessionCookieDomain(request);
  const secure = IS_PRODUCTION || domain !== undefined;
  if (domain) {
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
    });
  }
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    domain,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export async function destroySession(request: Request, response: Response): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (token) {
    const tokenHash = hashSessionToken(token);
    await db.delete(zohoMailConnectionsTable).where(eq(zohoMailConnectionsTable.sessionTokenHash, tokenHash));
    await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
  }
  const domain = sessionCookieDomain(request);
  const secure = IS_PRODUCTION || domain !== undefined;
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
  response.clearCookie(SESSION_COOKIE, cookieOptions);
  if (domain) response.clearCookie(SESSION_COOKIE, { ...cookieOptions, domain });
}

export async function loadUser(request: Request): Promise<UserRow | undefined> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return undefined;
  const rows = await db
    .select({ user: usersTable })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
    .where(and(eq(sessionsTable.tokenHash, hashSessionToken(token)), gt(sessionsTable.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.user;
}

export async function requireUser(request: Request, response: Response, next: NextFunction): Promise<void> {
  request.user = await loadUser(request);
  if (!request.user) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

async function authorizeStaffIdentity(request: Request, response: Response, roles: string[]): Promise<boolean> {
  if (!request.user || !roles.includes(request.user.role ?? "customer")) {
    response.status(403).json({ error: "You do not have permission to perform this action" });
    return false;
  }
  if (!IS_PRODUCTION) return true;

  try {
    const claims = await verifyCloudflareAccessAssertion(request);
    if (typeof claims?.email !== "string" || normalizeEmail(claims.email) !== normalizeEmail(request.user.email) || !request.user.emailVerifiedAt) {
      response.status(403).json({ error: "Cloudflare Access identity does not match the signed-in staff account" });
      return false;
    }
    const assertion = request.get("cf-access-jwt-assertion") ?? request.cookies?.afeonbooks_access;
    if (assertion) {
      response.cookie("afeonbooks_access", assertion, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        domain: SESSION_COOKIE_DOMAIN,
        maxAge: 15 * 60 * 1000,
        path: "/",
      });
    }
    return true;
  } catch (error) {
    logger.warn({ err: error, userId: request.user.id }, "Cloudflare Access authorization failed");
    response.status(403).json({ error: "Cloudflare Access authorization is required" });
    return false;
  }
}

export function requireStaffAccess(...roles: string[]) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (await authorizeStaffIdentity(request, response, roles)) next();
  };
}

export function requireRole(...roles: string[]) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (!await authorizeStaffIdentity(request, response, roles)) return;
    next();
  };
}

export { normalizeEmail };