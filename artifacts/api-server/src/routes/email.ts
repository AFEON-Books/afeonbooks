import { Router, type IRouter } from "express";
import { SendTestEmailBody, SendTestEmailResponse } from "@workspace/api-zod";
import { getOrCreateContent } from "./content";
import { renderEmailHtml, sendEmail, applyVars, buildVars } from "../lib/email";
import { logger } from "../lib/logger";
import type { OrderRow, OrderItemRow } from "@workspace/db";
import { requireRole, requireUser } from "../lib/auth";

const router: IRouter = Router();
const ZOHO_SCOPE = "ZohoMail.messages.CREATE,ZohoMail.accounts.READ";
const ZOHO_DEFAULT_REDIRECT_URI = "https://api.afeonbooks.com/api/email/zoho-callback";

router.get("/email/zoho-authorize", requireUser, requireRole("admin"), (req, res): void => {
  const clientId = process.env.ZOHO_CLIENT_ID;
  if (!clientId) {
    res.status(503).send("ZOHO_CLIENT_ID is not configured on the API server.");
    return;
  }

  const redirectUri = process.env.ZOHO_OAUTH_REDIRECT_URI || ZOHO_DEFAULT_REDIRECT_URI;
  const authUrl = new URL("/oauth/v2/auth", process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", ZOHO_SCOPE);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  res.redirect(authUrl.toString());
});

router.get("/email/zoho-callback", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const error = typeof req.query.error === "string" ? req.query.error : "";
  if (error) {
    res.status(400).type("text/plain").send(`Zoho authorization failed: ${error}`);
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    res.status(400).type("text/plain").send("Zoho authorization callback received no code.");
    return;
  }

  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(503).type("text/plain").send("ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be configured before authorization.");
    return;
  }

  const accountsUrl = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
  const redirectUri = process.env.ZOHO_OAUTH_REDIRECT_URI || ZOHO_DEFAULT_REDIRECT_URI;
  const tokenUrl = new URL("/oauth/v2/token", accountsUrl);
  tokenUrl.searchParams.set("code", code);
  tokenUrl.searchParams.set("grant_type", "authorization_code");
  tokenUrl.searchParams.set("client_id", clientId);
  tokenUrl.searchParams.set("client_secret", clientSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);

  try {
    const tokenResponse = await fetch(tokenUrl, { method: "POST" });
    const tokenText = await tokenResponse.text();
    let tokenBody: Record<string, unknown> = {};
    try { tokenBody = tokenText ? JSON.parse(tokenText) as Record<string, unknown> : {}; } catch {}

    if (!tokenResponse.ok || typeof tokenBody.refresh_token !== "string" || typeof tokenBody.access_token !== "string") {
      const description = typeof tokenBody.error === "string" ? tokenBody.error : tokenText || `HTTP ${tokenResponse.status}`;
      logger.error({ description, status: tokenResponse.status }, "Zoho OAuth code exchange failed");
      res.status(502).type("text/plain").send(`Zoho token exchange failed: ${description}`);
      return;
    }

    const accessToken = tokenBody.access_token;
    let accounts: unknown = null;
    let accountsError = "";
    try {
      const accountsResponse = await fetch(`${process.env.ZOHO_MAIL_API_URL || "https://mail.zoho.com"}/api/accounts`, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          Accept: "application/json",
        },
      });
      const accountsText = await accountsResponse.text();
      try {
        const parsed = accountsText ? JSON.parse(accountsText) as Record<string, unknown> : {};
        if (accountsResponse.ok) {
          const data = Array.isArray(parsed.data) ? parsed.data : [];
          accounts = data.map((item) => {
            const account = item as Record<string, unknown>;
            const emailAddresses = Array.isArray(account.emailAddress) ? account.emailAddress : [];
            const primaryEmail = emailAddresses.find((entry) => {
              const address = entry as Record<string, unknown>;
              return address.isAlias !== true;
            }) as Record<string, unknown> | undefined;
            return {
              accountId: account.accountId ?? account.accountid ?? account.zuid ?? null,
              emailAddress: primaryEmail?.emailAddress ?? account.mailboxAddress ?? account.primaryEmailAddress ?? null,
              accountName: account.accountDisplayName ?? account.accountName ?? account.displayName ?? null,
            };
          });
        } else {
          accountsError = typeof parsed.message === "string" ? parsed.message : accountsText || `HTTP ${accountsResponse.status}`;
        }
      } catch {
        accountsError = accountsText || `HTTP ${accountsResponse.status}`;
      }
    } catch (accountError) {
      accountsError = accountError instanceof Error ? accountError.message : "Unable to query Zoho accounts";
    }

    res.status(200).json({
      ok: true,
      message: "Zoho authorization succeeded. Store the refresh token in Render and never commit it to GitHub.",
      refreshToken: tokenBody.refresh_token,
      accessTokenExpiresIn: tokenBody.expires_in ?? 3600,
      apiDomain: tokenBody.api_domain ?? process.env.ZOHO_MAIL_API_URL ?? "https://mail.zoho.com",
      authenticatedUser: process.env.ZOHO_MAIL_AUTHENTICATED_USER || "aiden.chen@afeonbooks.com",
      fromAddress: process.env.ZOHO_MAIL_FROM_ADDRESS || process.env.ZOHO_MAIL_AUTHENTICATED_USER || "aiden.chen@afeonbooks.com",
      scope: ZOHO_SCOPE,
      accounts,
      accountsError: accountsError || undefined,
      nextSteps: [
        "Copy refreshToken into Render as ZOHO_MAIL_REFRESH_TOKEN.",
        "Copy the matching accountId for aiden.chen@afeonbooks.com into Render as ZOHO_MAIL_ACCOUNT_ID.",
        "Redeploy the API service, then use /admin/zoho-mail to run the connection check.",
      ],
    });
  } catch (err) {
    logger.error({ err }, "Zoho OAuth callback failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).type("text/plain").send(`Zoho OAuth callback failed: ${message}`);
  }
});

router.post("/email/test", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const body = SendTestEmailBody.parse(req.body);
  const content = await getOrCreateContent();
  const zohoConfigured = Boolean(
    process.env.ZOHO_MAIL_REFRESH_TOKEN &&
    process.env.ZOHO_CLIENT_ID &&
    process.env.ZOHO_CLIENT_SECRET &&
    process.env.ZOHO_MAIL_ACCOUNT_ID,
  );
  if (!zohoConfigured) {
    res.json(SendTestEmailResponse.parse({
      ok: false,
      message: "Zoho Mail credentials are not fully configured on the server.",
    }));
    return;
  }

  const sampleOrder: OrderRow = {
    id: 9999,
    school: content.school,
    customerName: "Sample Customer",
    customerEmail: body.to,
    customerPhone: "555-0100",
    shippingAddress: content.defaultShippingAddress || "123 Sample St",
    city: content.defaultShippingCity || "Sampletown",
    postalCode: content.defaultShippingPostalCode || "00000",
    country: content.defaultShippingCountry || "USA",
    classroom: "Room 101",
    useDefaultAddress: content.defaultShippingAddress ? "true" : "false",
    notes: null,
    customFields: "{}",
    orderType: "sale",
    paymentStatus: "due",
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    referrer: null,
    landingPage: null,
    guestAccessRevokedAt: null,
    paymentMethod: "cash_on_delivery",
    status: "pending",
    estimatedDeliveryDate: null,
    subtotalCents: 1499,
    discountCents: 0,
    shippingCents: 0,
    totalCents: 1499,
    currency: "USD",
    createdAt: new Date(),
  };
  const sampleItems: OrderItemRow[] = [{
    id: 1,
    orderId: 9999,
    productId: 1,
    productName: "The Terror Of The Evil Capybara",
    quantity: 1,
    unitPriceCents: 1499,
  }];
  const orderUrl = `https://click.afeonbooks.com/cloudflare/order/${sampleOrder.id}`;
  const vars = buildVars({ content, order: sampleOrder, orderUrl });
  const subject = `[TEST] ${applyVars(content.emailSubject, vars)}`;
  const html = renderEmailHtml({ content, order: sampleOrder, items: sampleItems, orderUrl });

  try {
    const result = await sendEmail({
      from: `AFEON Books <${process.env.ZOHO_MAIL_FROM_ADDRESS || process.env.ZOHO_MAIL_AUTHENTICATED_USER || "aiden.chen@afeonbooks.com"}>`,
      to: body.to,
      replyTo: content.emailReplyTo || "aiden.chen@afeonbooks.com",
      subject,
      html,
    });
    res.json(SendTestEmailResponse.parse({
      ok: true,
      emailId: result.id,
      message: `Test email sent to ${body.to}`,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "Zoho Mail test email failed");
    res.json(SendTestEmailResponse.parse({ ok: false, message: msg }));
  }
});

// Diagnostic only: validates the configured Zoho Mail OAuth credentials and account.
router.post("/email/zoho-diagnostic", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const configured = Boolean(
      process.env.ZOHO_MAIL_REFRESH_TOKEN &&
      process.env.ZOHO_CLIENT_ID &&
      process.env.ZOHO_CLIENT_SECRET &&
      process.env.ZOHO_MAIL_ACCOUNT_ID,
    );
    if (!configured) {
      res.status(503).json({ ok: false, message: "Zoho Mail credentials are not fully configured on the server." });
      return;
    }

    // A harmless access-token refresh validates OAuth without sending a message.
    // sendEmail is intentionally not called here.
    const response = await fetch(
      `${process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com"}/oauth/v2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: process.env.ZOHO_MAIL_REFRESH_TOKEN!,
          client_id: process.env.ZOHO_CLIENT_ID!,
          client_secret: process.env.ZOHO_CLIENT_SECRET!,
          grant_type: "refresh_token",
        }),
      },
    );
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch {}

    res.status(200).json({
      ok: response.ok && typeof body.access_token === "string",
      zohoStatus: response.status,
      authenticatedUser: process.env.ZOHO_MAIL_AUTHENTICATED_USER || "aiden.chen@afeonbooks.com",
      fromAddress: process.env.ZOHO_MAIL_FROM_ADDRESS || process.env.ZOHO_MAIL_AUTHENTICATED_USER || "aiden.chen@afeonbooks.com",
      accountIdConfigured: true,
      tokenRefreshSucceeded: response.ok && typeof body.access_token === "string",
      error: typeof body.error === "string" ? body.error : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "Zoho Mail diagnostic failed");
    res.status(500).json({ ok: false, message });
  }
});

export default router;
