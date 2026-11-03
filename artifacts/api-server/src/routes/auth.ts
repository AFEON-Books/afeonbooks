import { Router, type IRouter } from "express";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { authRateLimitsTable, authTokensTable, db, loyaltyTransactionsTable, usersTable } from "@workspace/db";
import {
  consumeAuthToken,
  createAuthToken,
  createSession,
  destroySession,
  hashPassword,
  loadUser,
  normalizeEmail,
  publicUser,
  requireRole,
  requireStaffAccess,
  requireUser,
  verifyPassword,
} from "../lib/auth";
import { sendEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { verifyTurnstileToken } from "../lib/turnstile";
import { verifyCloudflareAccessAssertion } from "../lib/cloudflare-access";

const AUTH_URL = (process.env.PUBLIC_AUTH_URL || "https://authn.afeonbooks.com").replace(/\/+$/, "");
const AUTH_FROM = process.env.ZOHO_AUTH_FROM_ADDRESS || "noreply@afeonbooks.com";
const INITIAL_ADMIN_EMAIL = normalizeEmail(process.env.INITIAL_ADMIN_EMAIL || "");
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
let rateLimitCleanupAt = 0;

function authCodeHash(value: string): string {
  const pepper = process.env.AUTH_CODE_PEPPER || process.env.DATABASE_URL;
  if (!pepper) throw new Error("AUTH_CODE_PEPPER or DATABASE_URL must be configured");
  return createHmac("sha256", pepper).update(value).digest("hex");
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
    await db.delete(authRateLimitsTable).where(sql`${authRateLimitsTable.windowStartedAt} < ${new Date(Date.now() - 24 * 60 * 60 * 1000)}`);
  }
  return (bucket?.attempts ?? limit + 1) <= limit;
}

async function sendEmailCode(userId: number, email: string): Promise<void> {
  const code = randomInt(0, 100_000).toString().padStart(5, "0");
  const tokenHash = authCodeHash(code);
  await db.transaction(async (tx) => {
    await tx.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.id, userId))
      .for("update")
      .limit(1);
    await tx.delete(authTokensTable).where(and(eq(authTokensTable.userId, userId), eq(authTokensTable.type, "email_code")));
    await tx.insert(authTokensTable).values({
      userId,
      tokenHash,
      type: "email_code",
      expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MS),
    });
  });
  try {
    await sendAuthEmail(
      email,
      "Your AFEON Books sign-in code",
      authEmailHtml("Sign in to AFEON Books", `Enter this five-digit code to sign in: ${code}. It expires in 10 minutes.`, `${AUTH_URL}/account`, "Open sign in"),
    );
  } catch (error) {
    await db.delete(authTokensTable).where(and(
      eq(authTokensTable.userId, userId),
      eq(authTokensTable.type, "email_code"),
      eq(authTokensTable.tokenHash, tokenHash),
    ));
    throw error;
  }
}

function authEmailHtml(title: string, intro: string, link: string, label: string): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;background:#FAF7F2;padding:32px"><div style="max-width:560px;margin:auto;background:#fff;padding:32px;border:1px solid #eee"><p style="font-size:12px;letter-spacing:2px;font-weight:bold;color:#888">AFEON BOOKS</p><h1>${escape(title)}</h1><p style="line-height:1.6">${escape(intro)}</p><p><a href="${escape(link)}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;text-decoration:none;font-weight:bold">${escape(label)}</a></p><p style="font-size:12px;color:#666;word-break:break-all">If the button does not work, use: ${escape(link)}</p></div></body></html>`;
}

async function sendAuthEmail(to: string, subject: string, html: string): Promise<void> {
  await sendEmail({ from: `AFEON Books <${AUTH_FROM}>`, to, subject, html });
}

const router: IRouter = Router();

router.get("/access/check", async (req, res): Promise<void> => {
  try {
    await verifyCloudflareAccessAssertion(req);
    res.set("Cache-Control", "no-store").status(204).end();
  } catch (error) {
    logger.warn({ err: error }, "Cloudflare Access check failed");
    res.status(403).set("Cache-Control", "no-store").json({ error: "Cloudflare Access authorization is required" });
  }
});

router.post("/auth/email-lookup", async (req, res): Promise<void> => {
  if (!(await verifyTurnstileToken(req.body?.["cf-turnstile-response"], "login"))) {
    res.status(403).json({ error: "Unable to verify request" });
    return;
  }
  const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }
  const emailKey = authCodeHash(`lookup:${email}`);
  if (!await consumeRateLimit(emailKey, 10)) {
    res.status(429).json({ error: "Too many sign-in requests. Try again in 15 minutes." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user) {
    res.json({ accountFound: false });
    return;
  }
  if (!user.emailVerifiedAt) {
    res.json({ accountFound: true, requiresVerification: true });
    return;
  }
  if (!await consumeRateLimit(authCodeHash(`code:${email}`), 3)) {
    res.status(429).json({ error: "Too many codes were requested. Try again in 15 minutes." });
    return;
  }
  await sendEmailCode(user.id, user.email);
  res.json({ accountFound: true, codeSent: true });
});

router.post("/auth/email-code/verify", async (req, res): Promise<void> => {
  if (!(await verifyTurnstileToken(req.body?.["cf-turnstile-response"], "login"))) {
    res.status(403).json({ error: "Unable to verify request" });
    return;
  }
  const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email) || !/^\d{5}$/.test(code)) {
    res.status(400).json({ error: "Enter the email address and five-digit code" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || !user.emailVerifiedAt) {
    res.status(400).json({ error: "This sign-in code is invalid or expired" });
    return;
  }
  const tokenHash = authCodeHash(code);
  const consumed = await db.transaction(async (tx) => {
    const [token] = await tx.select().from(authTokensTable).where(and(
      eq(authTokensTable.userId, user.id),
      eq(authTokensTable.type, "email_code"),
      isNull(authTokensTable.usedAt),
      gt(authTokensTable.expiresAt, new Date()),
    )).for("update").limit(1);
    if (!token || token.attempts >= 5) return false;
    const storedHash = Buffer.from(token.tokenHash, "hex");
    const submittedHash = Buffer.from(tokenHash, "hex");
    if (storedHash.length !== submittedHash.length || !timingSafeEqual(storedHash, submittedHash)) {
      const attempts = token.attempts + 1;
      await tx.update(authTokensTable).set({
        attempts,
        usedAt: attempts >= 5 ? new Date() : null,
      }).where(eq(authTokensTable.id, token.id));
      return false;
    }
    await tx.update(authTokensTable).set({ usedAt: new Date() }).where(eq(authTokensTable.id, token.id));
    return true;
  });
  if (!consumed) {
    res.status(400).json({ error: "This sign-in code is invalid or expired" });
    return;
  }
  await createSession(user.id, req, res);
  res.json({ user: publicUser(user) });
});

router.post("/auth/register", async (req, res): Promise<void> => {
  if (!(await verifyTurnstileToken(req.body?.["cf-turnstile-response"], "signup"))) {
    res.status(403).json({ error: "Unable to verify request" });
    return;
  }
  const { email, password, name } = req.body as { email?: unknown; password?: unknown; name?: unknown };
  if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }
  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (typeof name !== "string" || name.trim().length < 2) {
    res.status(400).json({ error: "Name is required" });
    return;
  }

  const normalizedEmail = normalizeEmail(email);
  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
  if (existing[0]) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }

  const [{ total }] = await db.select({ total: count() }).from(usersTable);
  const [user] = await db.insert(usersTable).values({
    email: normalizedEmail,
    passwordHash: await hashPassword(password),
    name: name.trim(),
    role: Number(total) === 0 && INITIAL_ADMIN_EMAIL.length > 0 && normalizedEmail === INITIAL_ADMIN_EMAIL ? "admin" : null,
    emailVerifiedAt: null,
  }).returning();
  const token = await createAuthToken(user.id, "verify_email", 1000 * 60 * 60 * 24);
  const link = `${AUTH_URL}/?verify_token=${encodeURIComponent(token)}`;
  try {
    await sendAuthEmail(user.email, "Verify your AFEON Books email", authEmailHtml("Verify your email", "Please verify your email address to activate your AFEON Books account.", link, "Verify email"));
  } catch (error) {
    await db.delete(usersTable).where(eq(usersTable.id, user.id));
    throw error;
  }
  res.status(201).json({ requiresVerification: true });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  if (!(await verifyTurnstileToken(req.body?.["cf-turnstile-response"], "login"))) {
    res.status(403).json({ error: "Unable to verify request" });
    return;
  }
  const { email, password } = req.body as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizeEmail(email))).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  if (!user.emailVerifiedAt) {
    res.status(403).json({ error: "Please verify your email before signing in" });
    return;
  }
  await createSession(user.id, req, res);
  res.json({ user: publicUser(user) });
});

router.get("/auth/admin/access", requireUser, requireStaffAccess("staff", "admin"), async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store").json({ user: publicUser(req.user!) });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  await destroySession(req, res);
  res.status(204).send();
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const user = await loadUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  if (!(await verifyTurnstileToken(req.body?.["cf-turnstile-response"], "password_reset"))) {
    res.status(403).json({ error: "Unable to verify request" });
    return;
  }
  const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
  const [user] = email ? await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1) : [];
  if (user) {
    const token = await createAuthToken(user.id, "reset_password", 1000 * 60 * 30);
    const link = `${AUTH_URL}/?reset_token=${encodeURIComponent(token)}`;
    try {
      await sendAuthEmail(user.email, "Reset your AFEON Books password", authEmailHtml("Reset your password", "Use the link below to choose a new password. This link expires in 30 minutes.", link, "Reset password"));
    } catch (error) {
      console.error("Password reset email failed", error);
    }
  }
  res.json({ message: "If an account exists for that email, a reset link has been sent." });
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  const userId = token ? await consumeAuthToken(token, "reset_password") : undefined;
  if (!userId) {
    res.status(400).json({ error: "This reset link is invalid or expired" });
    return;
  }
  const [user] = await db.update(usersTable).set({ passwordHash: await hashPassword(password) }).where(eq(usersTable.id, userId)).returning();
  if (!user) {
    res.status(400).json({ error: "This reset link is invalid or expired" });
    return;
  }
  await createSession(user.id, req, res);
  res.json({ user: publicUser(user) });
});

router.post("/auth/resend-verification", async (req, res): Promise<void> => {
  if (!(await verifyTurnstileToken(req.body?.["cf-turnstile-response"], "resend_verification"))) {
    res.status(403).json({ error: "Unable to verify request" });
    return;
  }
  const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
  const [user] = email ? await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1) : [];
  if (user && !user.emailVerifiedAt) {
    const token = await createAuthToken(user.id, "verify_email", 1000 * 60 * 60 * 24);
    const link = `${AUTH_URL}/?verify_token=${encodeURIComponent(token)}`;
    try {
      await sendAuthEmail(user.email, "Verify your AFEON Books email", authEmailHtml("Verify your email", "Please verify your email address to activate your AFEON Books account.", link, "Verify email"));
    } catch (error) {
      console.error("Verification email failed", error);
    }
  }
  res.json({ message: "If that account is waiting for verification, a new email has been sent." });
});

router.post("/auth/verify-email", async (req, res): Promise<void> => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const userId = token ? await consumeAuthToken(token, "verify_email") : undefined;
  if (!userId) {
    res.status(400).json({ error: "This verification link is invalid or expired" });
    return;
  }
  const [user] = await db.update(usersTable).set({ emailVerifiedAt: new Date() }).where(eq(usersTable.id, userId)).returning();
  if (!user) {
    res.status(400).json({ error: "This verification link is invalid or expired" });
    return;
  }
  await createSession(user.id, req, res);
  res.json({ user: publicUser(user) });
});

router.get("/auth/users", requireUser, requireRole("admin"), async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(desc(usersTable.createdAt));
  const transactions = await db
    .select({
      userId: loyaltyTransactionsTable.userId,
      balance: sql<number>`coalesce(sum(${loyaltyTransactionsTable.points}), 0)::int`,
    })
    .from(loyaltyTransactionsTable)
    .groupBy(loyaltyTransactionsTable.userId);
  const balances = new Map(transactions.map((transaction) => [transaction.userId, transaction.balance]));
  res.json({ users: users.map((user) => ({ ...publicUser(user), pointsBalance: balances.get(user.id) ?? 0 })) });
});

router.get("/auth/users/search", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length < 2) {
    res.json({ users: [] });
    return;
  }
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(or(ilike(usersTable.name, `%${query}%`), ilike(usersTable.email, `%${query}%`)))
    .orderBy(desc(usersTable.createdAt))
    .limit(10);
  res.json({ users });
});

router.get("/auth/users/by-email", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const email = typeof req.query.email === "string" ? normalizeEmail(req.query.email) : "";
  const [user] = email ? await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.email, email)).limit(1) : [];
  res.json({ user: user ?? null });
});

router.post("/auth/admin/create-user", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const { email, name } = req.body as { email?: unknown; name?: unknown };
  if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email.trim()) || typeof name !== "string" || name.trim().length < 2) {
    res.status(400).json({ error: "A valid name and email are required" });
    return;
  }
  const normalizedEmail = normalizeEmail(email);
  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
  if (existing[0]) {
    res.status(409).json({ error: "An account already exists for this email" });
    return;
  }

  const [user] = await db.insert(usersTable).values({
    email: normalizedEmail,
    name: name.trim(),
    passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
    role: null,
    emailVerifiedAt: new Date(),
  }).returning();
  const token = await createAuthToken(user.id, "reset_password", 1000 * 60 * 60 * 24 * 7);
  const link = `${AUTH_URL}/?reset_token=${encodeURIComponent(token)}`;
  try {
    await sendAuthEmail(user.email, "An AFEON Books admin created your account", authEmailHtml("Your AFEON Books account is ready", "An AFEON Books admin has added an account for you. Set your password using the link below to access your order history.", link, "Set your password"));
  } catch (error) {
    await db.delete(usersTable).where(eq(usersTable.id, user.id));
    throw error;
  }
  res.status(201).json({ user: publicUser(user) });
});

router.get("/auth/loyalty", requireUser, async (req, res): Promise<void> => {
  const transactions = await db
    .select()
    .from(loyaltyTransactionsTable)
    .where(eq(loyaltyTransactionsTable.userId, req.user!.id))
    .orderBy(desc(loyaltyTransactionsTable.createdAt));
  res.json({
    balance: transactions.reduce((total, transaction) => total + transaction.points, 0),
    transactions,
  });
});

router.post("/auth/users/:id/loyalty", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "Points and a description are required" });
    return;
  }
  const { points, description } = req.body as { points?: unknown; description?: unknown };
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }
  if (!Number.isSafeInteger(points) || (points as number) < 1 || (points as number) > 2_147_483_647) {
    res.status(400).json({ error: "Points must be a positive whole number" });
    return;
  }
  if (typeof description !== "string" || !description.trim() || description.trim().length > 200) {
    res.status(400).json({ error: "A description of 1 to 200 characters is required" });
    return;
  }
  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  await db.insert(loyaltyTransactionsTable).values({
    userId: id,
    orderId: null,
    points: points as number,
    description: description.trim(),
  });
  const [balance] = await db
    .select({ total: sql<number>`coalesce(sum(${loyaltyTransactionsTable.points}), 0)::int` })
    .from(loyaltyTransactionsTable)
    .where(eq(loyaltyTransactionsTable.userId, id));
  res.status(201).json({ pointsBalance: balance?.total ?? points });
});

router.patch("/auth/users/:id/role", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { role } = req.body as { role?: unknown };
  if (!Number.isInteger(id) || ![null, "staff", "admin"].includes(role as string | null)) {
    res.status(400).json({ error: "Role must be null, staff, or admin" });
    return;
  }
  if (id === req.user?.id && role !== "admin") {
    res.status(400).json({ error: "You cannot remove your own admin role" });
    return;
  }
  const [user] = await db.update(usersTable).set({ role: role as string | null }).where(eq(usersTable.id, id)).returning();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ user: publicUser(user) });
});

export default router;