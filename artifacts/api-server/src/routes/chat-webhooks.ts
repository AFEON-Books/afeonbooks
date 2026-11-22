import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { chatRoomWebhooksTable, chatRoomsTable, db } from "@workspace/db";
import { z } from "zod";
import { encryptValue } from "../lib/chat-webhook";
import { requireStaffAccess, requireUser } from "../lib/auth";

const router: IRouter = Router();
const webhookBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().url().max(512),
  webhookSecret: z.string().max(2_048).optional().default(""),
  clearSecret: z.boolean().optional().default(false),
  enableMtls: z.boolean(),
  clientCertificate: z.string().max(20_000).optional().default(""),
  clientKey: z.string().max(20_000).optional().default(""),
});

function parseRoomId(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function encryptionKeyIsReady(): boolean {
  const encoded = process.env.MAIL_TOKEN_ENCRYPTION_KEY;
  return Boolean(encoded && Buffer.from(encoded, "base64").length === 32);
}

function isAllowedDestination(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "webhook.afeonbooks.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/usw-2", "/use-2", "/usw-2/", "/use-2/"].includes(url.pathname)
    ) return undefined;
    url.pathname = url.pathname.replace(/\/$/, "");
    return url;
  } catch {
    return undefined;
  }
}

async function getAlertsRoom(roomId: number) {
  const [room] = await db.select({ id: chatRoomsTable.id })
    .from(chatRoomsTable)
    .where(and(
      eq(chatRoomsTable.id, roomId),
      eq(chatRoomsTable.type, "channel"),
      sql`lower(${chatRoomsTable.name}) = 'alerts'`,
    ))
    .limit(1);
  return room;
}

router.get("/chat/rooms/:id/webhook", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const roomId = parseRoomId(request.params.id);
  if (!roomId || !await getAlertsRoom(roomId)) {
    response.status(404).json({ error: "Channel not found." });
    return;
  }
  const [webhook] = await db.select({
    name: chatRoomWebhooksTable.name,
    url: chatRoomWebhooksTable.url,
    secretConfigured: chatRoomWebhooksTable.encryptedSecret,
    mtlsEnabled: chatRoomWebhooksTable.mtlsEnabled,
  })
    .from(chatRoomWebhooksTable)
    .where(eq(chatRoomWebhooksTable.roomId, roomId))
    .limit(1);
  response.json({
    webhook: webhook ? {
      name: webhook.name,
      url: webhook.url,
      secretConfigured: Boolean(webhook.secretConfigured),
      mtlsEnabled: webhook.mtlsEnabled,
    } : null,
  });
});

router.put("/chat/rooms/:id/webhook", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const roomId = parseRoomId(request.params.id);
  if (!roomId || !await getAlertsRoom(roomId)) {
    response.status(404).json({ error: "Channel not found." });
    return;
  }
  const parsed = webhookBodySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a name, valid HTTPS URL, and valid webhook settings." });
    return;
  }
  const body = parsed.data;
  if (body.clearSecret && body.webhookSecret) {
    response.status(400).json({ error: "Enter a new secret or choose to remove the saved secret, not both." });
    return;
  }
  const url = isAllowedDestination(body.url);
  if (!url) {
    response.status(400).json({ error: "Use https://webhook.afeonbooks.com/usw-2 or https://webhook.afeonbooks.com/use-2." });
    return;
  }

  const [existing] = await db.select()
    .from(chatRoomWebhooksTable)
    .where(eq(chatRoomWebhooksTable.roomId, roomId))
    .limit(1);
  const certificate = body.clientCertificate.trim();
  const privateKey = body.clientKey.trim();
  if (Boolean(certificate) !== Boolean(privateKey)) {
    response.status(400).json({ error: "Provide both the mTLS client certificate and private key." });
    return;
  }
  if (
    (certificate && !certificate.includes("-----BEGIN CERTIFICATE-----")) ||
    (privateKey && !/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(privateKey))
  ) {
    response.status(400).json({ error: "The mTLS certificate or private key is not valid PEM text." });
    return;
  }
  if (body.enableMtls && !certificate && !existing?.encryptedClientCertificate) {
    response.status(400).json({ error: "Enter the mTLS client certificate and private key to enable mTLS." });
    return;
  }
  if (body.enableMtls && !privateKey && !existing?.encryptedClientKey) {
    response.status(400).json({ error: "Enter the mTLS client certificate and private key to enable mTLS." });
    return;
  }
  if ((body.webhookSecret || certificate || privateKey) && !encryptionKeyIsReady()) {
    response.status(503).json({ error: "Webhook credential encryption is not configured on the API server." });
    return;
  }

  const encryptedSecret = body.clearSecret
    ? null
    : body.webhookSecret
      ? encryptValue(body.webhookSecret)
      : existing?.encryptedSecret ?? null;
  const encryptedClientCertificate = body.enableMtls
    ? certificate
      ? encryptValue(certificate)
      : existing?.encryptedClientCertificate ?? null
    : null;
  const encryptedClientKey = body.enableMtls
    ? privateKey
      ? encryptValue(privateKey)
      : existing?.encryptedClientKey ?? null
    : null;
  const values = {
    name: body.name,
    url: url.toString(),
    encryptedSecret,
    mtlsEnabled: body.enableMtls,
    encryptedClientCertificate,
    encryptedClientKey,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(chatRoomWebhooksTable)
      .set(values)
      .where(eq(chatRoomWebhooksTable.roomId, roomId));
  } else {
    await db.insert(chatRoomWebhooksTable)
      .values({ roomId, ...values });
  }
  response.json({
    webhook: {
      name: values.name,
      url: values.url,
      secretConfigured: Boolean(values.encryptedSecret),
      mtlsEnabled: values.mtlsEnabled,
    },
  });
});

router.delete("/chat/rooms/:id/webhook", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const roomId = parseRoomId(request.params.id);
  if (!roomId || !await getAlertsRoom(roomId)) {
    response.status(404).json({ error: "Channel not found." });
    return;
  }
  await db.delete(chatRoomWebhooksTable)
    .where(eq(chatRoomWebhooksTable.roomId, roomId));
  response.status(204).end();
});

export default router;
