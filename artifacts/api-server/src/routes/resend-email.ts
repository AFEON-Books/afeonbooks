import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, orderItemsTable, ordersTable } from "@workspace/db";
import { renderEmailHtml, sendEmail, applyVars, buildVars } from "../lib/email";
import { logger } from "../lib/logger";
import { requireRole, requireUser } from "../lib/auth";
import { getOrCreateContent } from "./content";
import { createOrderAccessToken } from "../lib/order-access";

const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://afeonbooks.com").trim().replace(/\/+$/, "");
const router: IRouter = Router();

function zohoConfigured() {
  return Boolean(
    process.env.ZOHO_MAIL_REFRESH_TOKEN &&
    process.env.ZOHO_CLIENT_ID &&
    process.env.ZOHO_CLIENT_SECRET &&
    process.env.ZOHO_MAIL_ACCOUNT_ID,
  );
}

router.post("/orders/:id/resend-email", requireUser, requireRole("staff", "admin"), async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ ok: false, message: "Invalid order ID" });
      return;
    }
    if (!zohoConfigured()) {
      res.status(503).json({ ok: false, message: "Zoho Mail credentials are not fully configured on the server." });
      return;
    }

    const order = (await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1))[0];
    if (!order) {
      res.status(404).json({ ok: false, message: "Order not found" });
      return;
    }

    const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, id));
    const content = await getOrCreateContent();
    if (content.emailEnabled !== "true") {
      res.status(409).json({ ok: false, message: "Emails are disabled in Email Settings." });
      return;
    }

    const accessToken = await createOrderAccessToken(order.id);
    const orderUrl = `${PUBLIC_SITE_URL}/order/${order.id}${accessToken ? `#access_token=${encodeURIComponent(accessToken)}` : ""}`;
    const vars = buildVars({ content, order, orderUrl });
    const subject = applyVars(content.emailSubject, vars);
    const html = renderEmailHtml({ content, order, items, orderUrl });
    const fromName = content.emailFromName || content.brandName || "AFEON Books";

    const result = await sendEmail({
      from: `${fromName} <${process.env.ZOHO_MAIL_FROM_ADDRESS || process.env.ZOHO_MAIL_AUTHENTICATED_USER || "aiden.chen@afeonbooks.com"}>`,
      to: order.customerEmail,
      replyTo: content.emailReplyTo || "aiden.chen@afeonbooks.com",
      subject,
      html,
    });

    logger.info({ orderId: order.id, emailId: result.id }, "order confirmation email resent via Zoho Mail");
    res.json({ ok: true, message: `Email resent to ${order.customerEmail}`, emailId: result.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, orderId: req.params.id }, "failed to resend order confirmation email via Zoho Mail");
    res.status(500).json({ ok: false, message });
  }
});

export default router;
