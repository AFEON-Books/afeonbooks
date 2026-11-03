import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db, orderAccessTokensTable, ordersTable } from "@workspace/db";
import { hashSessionToken } from "./auth";

const ORDER_ACCESS_TTL_MS = 1000 * 60 * 60 * 24 * 365;

export function newOrderAccessToken() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + ORDER_ACCESS_TTL_MS),
  };
}

export async function createOrderAccessToken(orderId: number): Promise<string | undefined> {
  const token = newOrderAccessToken();
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ guestAccessRevokedAt: ordersTable.guestAccessRevokedAt })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .for("update");
    if (!order || order.guestAccessRevokedAt) return undefined;

    await tx
      .delete(orderAccessTokensTable)
      .where(and(eq(orderAccessTokensTable.orderId, orderId), lt(orderAccessTokensTable.expiresAt, new Date())));
    await tx.insert(orderAccessTokensTable).values({
      orderId,
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    });
    return token.token;
  });
}

export async function hasOrderAccess(orderId: number, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const [found] = await db
    .select({ id: orderAccessTokensTable.id })
    .from(orderAccessTokensTable)
    .innerJoin(ordersTable, eq(ordersTable.id, orderAccessTokensTable.orderId))
    .where(and(
      eq(orderAccessTokensTable.orderId, orderId),
      eq(orderAccessTokensTable.tokenHash, hashSessionToken(token)),
      gt(orderAccessTokensTable.expiresAt, new Date()),
      isNull(orderAccessTokensTable.revokedAt),
      isNull(ordersTable.guestAccessRevokedAt),
    ))
    .limit(1);
  return Boolean(found);
}
