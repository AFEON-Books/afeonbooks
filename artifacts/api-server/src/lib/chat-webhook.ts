import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { and, eq, sql } from "drizzle-orm";
import { chatRoomWebhooksTable, chatRoomsTable, db } from "@workspace/db";
import { logger } from "./logger";

function getEncryptionKey(): Buffer {
  const encoded = process.env.MAIL_TOKEN_ENCRYPTION_KEY;
  const key = encoded ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error("MAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

function decryptValue(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Stored webhook credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptValue(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

interface WebhookMessage {
  id: number;
  senderUserId: number;
  senderName: string;
  message: string;
  createdAt: Date;
}

function postWebhook(
  url: URL,
  body: string,
  options: { secret?: string; certificate?: string; privateKey?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(options.secret ? { "X-Webhook-Secret": options.secret } : {}),
      },
      ...(options.certificate && options.privateKey
        ? { cert: options.certificate, key: options.privateKey }
        : {}),
      timeout: 8_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("timeout", () => request.destroy(new Error("Webhook request timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

export async function dispatchAlertsWebhook(message: WebhookMessage): Promise<void> {
  try {
    const [destination] = await db.select({ webhook: chatRoomWebhooksTable })
      .from(chatRoomWebhooksTable)
      .innerJoin(chatRoomsTable, eq(chatRoomWebhooksTable.roomId, chatRoomsTable.id))
      .where(and(
        eq(chatRoomsTable.type, "channel"),
        sql`lower(${chatRoomsTable.name}) = 'alerts'`,
      ))
      .limit(1);
    if (!destination) return;

    const config = destination.webhook;
    const options = {
      ...(config.encryptedSecret ? { secret: decryptValue(config.encryptedSecret) } : {}),
      ...(config.mtlsEnabled && config.encryptedClientCertificate && config.encryptedClientKey
        ? {
          certificate: decryptValue(config.encryptedClientCertificate),
          privateKey: decryptValue(config.encryptedClientKey),
        }
        : {}),
    };
    const body = JSON.stringify({
      event: "chat.message.created",
      channel: "#alerts",
      message: {
        id: message.id,
        text: message.message,
        author: message.senderName,
        createdAt: message.createdAt.toISOString(),
      },
    });

    const primaryUrl = new URL(config.url);
    const fallbackUrl = new URL(primaryUrl);
    fallbackUrl.pathname = primaryUrl.pathname.endsWith("/usw-2") ? "/use-2" : "/usw-2";
    let status: number;
    try {
      status = await postWebhook(primaryUrl, body, options);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : "Unknown error" }, "Primary #alerts webhook delivery failed");
      status = 0;
    }

    if (status >= 200 && status < 300) return;
    if (status >= 400 && status < 500) {
      logger.warn({ status }, "#alerts webhook rejected the event");
      return;
    }

    try {
      status = await postWebhook(fallbackUrl, body, options);
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : "Unknown error" }, "Failover #alerts webhook delivery failed");
      return;
    }
    if (status < 200 || status >= 300) {
      logger.error({ status }, "Failover #alerts webhook rejected the event");
    }
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : "Unknown error" }, "Unable to deliver #alerts webhook");
  }
}

export { encryptValue };
