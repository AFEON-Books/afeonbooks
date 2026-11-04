import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authTokensTable, db, sessionsTable, usersTable, zohoMailConnectionsTable, type UserRow } from "@workspace/db";

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

export async function createSession(userId: number, request: Request, response: Response, githubUserId?: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessionsTable).values({
    tokenHash: hashSessionToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    githubUserId: githubUserId ?? null,
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
  const user = rows[0]?.user;
  if (user?.email.endsWith("@github.afeonbooks.invalid")) return undefined;
  return user;
}

export async function markSessionGithubOrganizationVerified(request: Request, githubUserId: string): Promise<boolean> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token || !request.user) return false;
  const [session] = await db.update(sessionsTable)
    .set({ githubUserId })
    .where(and(
      eq(sessionsTable.tokenHash, hashSessionToken(token)),
      eq(sessionsTable.userId, request.user.id),
      gt(sessionsTable.expiresAt, new Date()),
    ))
    .returning({ userId: sessionsTable.userId });
  return session?.userId === request.user.id;
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

  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) {
    response.status(403).json({ error: "Sign in with GitHub to access staff tools" });
    return false;
  }
  const [session] = await db.select({ githubUserId: sessionsTable.githubUserId })
    .from(sessionsTable)
    .where(and(
      eq(sessionsTable.tokenHash, hashSessionToken(token)),
      eq(sessionsTable.userId, request.user.id),
      gt(sessionsTable.expiresAt, new Date()),
    ))
    .limit(1);
  if (!session?.githubUserId) {
    response.status(403).json({ error: "An active GitHub organization sign-in is required" });
    return false;
  }
  return true;
}

export function requireStaffAccess(...roles: string[]) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (await authorizeStaffIdentity(request, response, roles)) next();
  };
}

export function requireGithubOrganizationMember() {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (!request.user) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) {
      response.status(403).json({ error: "Sign in with a GitHub organization account to change maintenance mode" });
      return;
    }
    const [session] = await db.select({ githubUserId: sessionsTable.githubUserId })
      .from(sessionsTable)
      .where(and(
        eq(sessionsTable.tokenHash, hashSessionToken(token)),
        eq(sessionsTable.userId, request.user.id),
        gt(sessionsTable.expiresAt, new Date()),
      ))
      .limit(1);
    if (!session?.githubUserId) {
      response.status(403).json({ error: "Sign in with a GitHub organization account to change maintenance mode" });
      return;
    }
    next();
  };
}

export function requireRole(...roles: string[]) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (!await authorizeStaffIdentity(request, response, roles)) return;
    next();
  };
}

export { normalizeEmail };