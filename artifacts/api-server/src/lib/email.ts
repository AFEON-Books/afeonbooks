import { logger } from "./logger";
import type { OrderRow, OrderItemRow, SiteContentRow } from "@workspace/db";

const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const ZOHO_MAIL_API_URL = process.env.ZOHO_MAIL_API_URL || "https://mail.zoho.com";
const ZOHO_AUTHENTICATED_USER = process.env.ZOHO_MAIL_AUTHENTICATED_USER || "aiden.chen@afeonbooks.com";
const ZOHO_DEFAULT_FROM = process.env.ZOHO_MAIL_FROM_ADDRESS || ZOHO_AUTHENTICATED_USER;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatPrice(cents: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
export interface TemplateVars { customerName:string; customerEmail:string; orderId:string; total:string; paymentMethod:string; shippingAddress:string; classroom:string; brandName:string; orderUrl:string; }
export function applyVars(template:string, vars:TemplateVars):string {
  const map=vars as unknown as Record<string,string>;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g,(_,key:string)=>{const v=map[key];return v===undefined?`{{${key}}}`:v;});
}
export interface RenderEmailInput { content:SiteContentRow; order:OrderRow; items:OrderItemRow[]; orderUrl:string; }
interface BrandedEmailInput {
  title: string;
  bodyHtml: string;
  accentColor?: string;
  footerHtml?: string;
  footerNote?: string;
}

const DEFAULT_EMAIL_ACCENT = "#7DD3EA";
const PUBLIC_SITE_URL = "https://afeonbooks.com";
const EMAIL_LOGO_URL = "https://msxfhfdeqxqvjuypcspm.supabase.co/storage/v1/object/public/photos/afeonbooks-logo.png";
const INSTAGRAM_URL = "https://go.afeonbooks.com/ins";

function emailAccentColor(value?: string): string {
  return /^#[\da-f]{6}$/i.test(value || "") ? value! : DEFAULT_EMAIL_ACCENT;
}

export function renderBrandedEmail({ title, bodyHtml, accentColor, footerHtml, footerNote }: BrandedEmailInput): string {
  const accent = emailAccentColor(accentColor);
  const footer = footerHtml ? `<tr><td style="padding:24px 40px 32px;border-top:1px solid #eee;font-size:13px;line-height:1.6;color:#666;">${footerHtml}</td></tr>` : "";
  const customNote = footerNote && footerNote !== "© 2026 AFR Group. All Rights Reserved."
    ? `<div style="margin-top:8px;">${escapeHtml(footerNote)}</div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:12px;"><tr><td align="center"><table role="presentation" width="815" cellpadding="0" cellspacing="0" style="max-width:815px;width:100%;background:#fff;border:1px solid #eee;border-top:14px solid ${accent};"><tr><td style="padding:30px 50px 0;"><img src="${EMAIL_LOGO_URL}" width="100" height="100" alt="AFEON Books" style="display:block;width:100px;height:100px;object-fit:contain;border:0;"></td></tr><tr><td style="padding:16px 50px 16px;">${bodyHtml}</td></tr>${footer}</table><div style="max-width:815px;margin:12px auto 0;padding:0 12px;font-size:16px;line-height:1.5;color:#222;text-align:center;">Copyright © AFEON Books.<div style="margin-top:22px;"><a href="${PUBLIC_SITE_URL}" style="color:#222;text-decoration:none;">www.afeonbooks.com</a></div><div style="margin-top:16px;"><a href="${INSTAGRAM_URL}" aria-label="AFEON Books on Instagram" style="display:inline-block;width:28px;height:28px;border:3px solid #333;border-radius:9px;line-height:28px;text-decoration:none;"><span style="display:inline-block;vertical-align:middle;width:11px;height:11px;border:3px solid #333;border-radius:50%;"></span><span style="display:inline-block;vertical-align:top;margin:4px 0 0 1px;width:4px;height:4px;background:#333;border-radius:50%;"></span></a></div>${customNote}</div></td></tr></table></body></html>`;
}

export function buildVars({content,order,orderUrl}:{content:SiteContentRow;order:OrderRow;orderUrl:string}):TemplateVars {
  const useDefault=order.useDefaultAddress==="true";
  const shippingLines:string[]=[];
  if(useDefault&&order.classroom)shippingLines.push(`Classroom ${order.classroom}`);
  shippingLines.push(order.shippingAddress);
  shippingLines.push(`${order.city}, ${order.postalCode}`);
  shippingLines.push(order.country);
  return {customerName:order.customerName,customerEmail:order.customerEmail,orderId:String(order.id),total:formatPrice(order.totalCents,order.currency),paymentMethod:order.paymentMethod==="cash_on_delivery"?"Cash on Delivery":order.paymentMethod,shippingAddress:shippingLines.filter(Boolean).join(", "),classroom:order.classroom??"",brandName:content.brandName,orderUrl};
}
export function renderEmailHtml(input:RenderEmailInput):string {
  const {content,order,items,orderUrl}=input;
  const vars=buildVars({content,order,orderUrl});
  const accent=emailAccentColor(content.emailAccentColor||content.accentColor);
  const heading=applyVars(content.emailHeading,vars);
  const intro=applyVars(content.emailIntro,vars);
  const footer=applyVars(content.emailFooter,vars);
  const buttonLabel=applyVars(content.emailButtonLabel,vars);
  const useDefault=order.useDefaultAddress==="true";
  const shippingHtml=[useDefault&&order.classroom?`<strong>Classroom ${escapeHtml(order.classroom)}</strong>`:"",escapeHtml(order.shippingAddress),`${escapeHtml(order.city)}, ${escapeHtml(order.postalCode)}`,escapeHtml(order.country)].filter(Boolean).join("<br>");
  const itemsRows=items.map(it=>`<tr><td style="padding:12px 0;border-bottom:1px solid #eee;font-size:14px;"><strong>${escapeHtml(it.productName)}</strong><br><span style="color:#666;font-size:12px;">Qty ${it.quantity} × ${formatPrice(it.unitPriceCents,order.currency)}</span></td><td style="padding:12px 0;border-bottom:1px solid #eee;font-size:14px;text-align:right;font-weight:bold;">${formatPrice(it.unitPriceCents*it.quantity,order.currency)}</td></tr>`).join("");
  const introHtml=escapeHtml(intro).replace(/\n/g,"<br>");
  const footerHtml=escapeHtml(footer).replace(/\n/g,"<br>");
  const bodyHtml = `<h1 style="margin:0;font-size:24px;line-height:1.3;font-weight:700;">${escapeHtml(heading)}</h1><p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#333;">${introHtml}</p><p style="margin:24px 0 0;"><a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:${escapeHtml(accent)};color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;font-size:14px;">${escapeHtml(buttonLabel)}</a></p><div style="margin-top:32px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#777;font-weight:700;">Order Summary</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-top:1px solid #eee;">${itemsRows}<tr><td style="padding:16px 0 0;font-size:14px;color:#666;">Subtotal</td><td style="padding:16px 0 0;font-size:14px;text-align:right;">${formatPrice(order.subtotalCents,order.currency)}</td></tr><tr><td style="padding:6px 0;font-size:14px;color:#666;">Shipping</td><td style="padding:6px 0;font-size:14px;text-align:right;">${order.shippingCents===0?"Free":formatPrice(order.shippingCents,order.currency)}</td></tr><tr><td style="padding:12px 0 0;font-size:16px;font-weight:700;border-top:1px solid #eee;">Total</td><td style="padding:12px 0 0;font-size:16px;text-align:right;font-weight:700;border-top:1px solid #eee;">${formatPrice(order.totalCents,order.currency)}</td></tr></table><div style="margin-top:24px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#777;font-weight:700;">Shipping To</div><div style="margin-top:8px;font-size:14px;line-height:1.6;color:#333;">${shippingHtml}</div><div style="margin-top:24px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#777;font-weight:700;">Payment</div><div style="margin-top:8px;font-size:14px;color:#333;">${escapeHtml(vars.paymentMethod)}</div>`;
  return renderBrandedEmail({
    title: applyVars(content.emailSubject,vars),
    bodyHtml,
    accentColor: accent,
    footerHtml: footerHtml || undefined,
    footerNote: content.footerNote,
  });
}

export interface SendEmailArgs { from:string; to:string|string[]; replyTo?:string; subject:string; html:string; }
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getZohoAccessToken(): Promise<string> {
  const refreshToken = process.env.ZOHO_MAIL_REFRESH_TOKEN;
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("ZOHO_MAIL_REFRESH_TOKEN, ZOHO_CLIENT_ID, and ZOHO_CLIENT_SECRET must be configured");
  }
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.token;

  const tokenUrl = new URL("/oauth/v2/token", ZOHO_ACCOUNTS_URL);
  tokenUrl.searchParams.set("refresh_token", refreshToken);
  tokenUrl.searchParams.set("client_id", clientId);
  tokenUrl.searchParams.set("client_secret", clientSecret);
  tokenUrl.searchParams.set("grant_type", "refresh_token");

  const response = await fetch(tokenUrl, { method: "POST" });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch {}
  const token = typeof body.access_token === "string" ? body.access_token : "";
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  if (!response.ok || !token) {
    const description = typeof body.error === "string" ? body.error : text || `HTTP ${response.status}`;
    throw new Error(`Zoho OAuth token refresh failed: ${description}`);
  }
  cachedAccessToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

function getFromAddress(args: SendEmailArgs): string {
  const match = args.from.match(/^(.*) <([^>]+)>$/);
  return match?.[2]?.trim() || args.from.trim() || ZOHO_DEFAULT_FROM;
}
function getFromName(args: SendEmailArgs): string | undefined {
  const match = args.from.match(/^(.*) <([^>]+)>$/);
  return match?.[1]?.trim() || undefined;
}

export async function sendEmail(args:SendEmailArgs):Promise<{id:string}> {
  const accountId = process.env.ZOHO_MAIL_ACCOUNT_ID;
  if (!accountId) throw new Error("ZOHO_MAIL_ACCOUNT_ID is not configured");
  const accessToken = await getZohoAccessToken();
  const recipients=Array.isArray(args.to)?args.to:[args.to];
  const payload: Record<string, unknown> = {
    fromAddress: getFromAddress(args),
    toAddress: recipients.join(","),
    subject: args.subject,
    content: args.html,
    mailFormat: "html",
  };

  const response = await fetch(`${ZOHO_MAIL_API_URL}/api/accounts/${encodeURIComponent(accountId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  let body: Record<string, unknown> = {};
  try { body = responseText ? JSON.parse(responseText) as Record<string, unknown> : {}; } catch {}
  const statusBlock = body.status as Record<string, unknown> | undefined;
  const description = typeof statusBlock?.description === "string" ? statusBlock.description : responseText;
  const data = body.data as Record<string, unknown> | undefined;
  const messageId = typeof data?.messageId === "string" ? data.messageId : typeof data?.messageid === "string" ? data.messageid : "";
  if (!response.ok || (statusBlock && statusBlock.code !== 200)) {
    throw new Error(`Zoho Mail HTTP ${response.status}: ${description || "send failed"}`);
  }
  return { id: messageId };
}

export async function sendOrderConfirmation(input:RenderEmailInput):Promise<void>{
  const {content,order}=input;
  if(content.emailEnabled!=="true"){
    logger.info({orderId:order.id},"order confirmation email skipped (disabled)");
    return;
  }
  const configured = Boolean(process.env.ZOHO_MAIL_REFRESH_TOKEN && process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_MAIL_ACCOUNT_ID);
  if(!configured){
    logger.warn({orderId:order.id},"order confirmation email skipped: Zoho Mail credentials are not fully configured");
    return;
  }
  const vars=buildVars({content,order,orderUrl:input.orderUrl});
  const subject=applyVars(content.emailSubject,vars);
  const html=renderEmailHtml(input);
  const fromName=content.emailFromName||content.brandName||"Store";
  const from=`${fromName} <${ZOHO_DEFAULT_FROM}>`;
  try{
    const result=await sendEmail({from,to:order.customerEmail,replyTo:content.emailReplyTo||ZOHO_AUTHENTICATED_USER,subject,html});
    logger.info({orderId:order.id,emailId:result.id,fromAddress:ZOHO_DEFAULT_FROM},"order confirmation email sent via Zoho Mail");
  }catch(err){
    logger.error({err,orderId:order.id},"failed to send order confirmation email via Zoho Mail");
  }
}

export async function sendOrderStatusUpdateEmail(
  order: OrderRow,
  status: string,
  estimatedDeliveryDate?: string | null,
  accessToken?: string,
): Promise<void> {
  const configured = Boolean(process.env.ZOHO_MAIL_REFRESH_TOKEN && process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_MAIL_ACCOUNT_ID);
  if (!configured) {
    logger.warn({ orderId: order.id, status }, "order status email skipped: Zoho Mail credentials are not fully configured");
    return;
  }

  const fromAddress = "noreply@afeonbooks.com";
  const siteUrl = (process.env.PUBLIC_SITE_URL || "https://afeonbooks.com").replace(/\/+$/, "");
  const orderUrl = `${siteUrl}/order/${order.id}${accessToken ? `#access_token=${encodeURIComponent(accessToken)}` : ""}`;
  const safeStatus = escapeHtml(status.replace(/_/g, " "));
  const deliveryHtml = estimatedDeliveryDate ? `<p style="margin:16px 0 0;">Estimated delivery date: <strong>${escapeHtml(estimatedDeliveryDate)}</strong></p>` : "";
  const bodyHtml = `<h1 style="margin:0;font-size:24px;line-height:1.3;font-weight:700;">Order #${order.id} status updated</h1><p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#333;">Hello ${escapeHtml(order.customerName)},</p><p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#333;">Your order status is now <strong>${safeStatus}</strong>.</p>${deliveryHtml}<p style="margin:24px 0 0;"><a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:${DEFAULT_EMAIL_ACCENT};color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;font-size:14px;">View your order</a></p>`;
  const html = renderBrandedEmail({ title: `Order #${order.id} status updated`, bodyHtml });

  try {
    const result = await sendEmail({
      from: `AFEON Books <${fromAddress}>`,
      to: order.customerEmail,
      replyTo: "noreply@afeonbooks.com",
      subject: `Order #${order.id} status updated: ${status.replace(/_/g, " ")}${estimatedDeliveryDate ? ` (estimated delivery ${estimatedDeliveryDate})` : ""}`,
      html,
    });
    logger.info({ orderId: order.id, status, emailId: result.id, fromAddress }, "order status email sent via Zoho Mail");
  } catch (err) {
    logger.error({ err, orderId: order.id, status }, "failed to send order status email via Zoho Mail");
  }
}
