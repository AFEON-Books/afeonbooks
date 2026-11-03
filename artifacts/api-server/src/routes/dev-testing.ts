import { Router, type IRouter } from "express";
import { db, ordersTable, orderItemsTable, pool, productsTable } from "@workspace/db";
import type { OrderRow, OrderItemRow } from "@workspace/db";

import type { ProductRow } from "@workspace/db";
import { requireRole, requireUser } from "../lib/auth";
import { logger } from "../lib/logger";

type Snapshot = {
  orders: OrderRow[];
  orderItems: OrderItemRow[];
  products: ProductRow[];
  expiresAt: number;
};

let activeSession: Snapshot | null = null;

const DURATION_MS = 10 * 60 * 1000;
const SUPPORTED_SUPABASE_PORTS = [5432, 6543];

const router: IRouter = Router();

router.post("/dev-testing/database-connection", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const requestedPort = req.body?.port;
  if (!SUPPORTED_SUPABASE_PORTS.includes(requestedPort)) {
    res.status(400).json({ connected: false, error: "Use a supported Supabase PostgreSQL port: 5432 or 6543." });
    return;
  }

  let configuredPort: number | null = null;
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      res.status(503).json({ connected: false, error: "DATABASE_URL is not configured on the API server." });
      return;
    }

    configuredPort = Number(new URL(databaseUrl).port || "5432");
    await pool.query("SELECT 1");

    res.json({
      connected: true,
      configuredPort,
      portMatches: configuredPort === requestedPort,
    });
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
    logger.error({ errorCode, configuredPort }, "Database connection check failed");
    res.status(503).json({
      connected: false,
      configuredPort,
      error: "Could not connect to the API server's configured database. Check DATABASE_URL and the Supabase connection settings.",
    });
  }
});

router.get("/dev-testing/status", requireUser, requireRole("admin"), (_req, res) => {
  if (!activeSession || Date.now() > activeSession.expiresAt) {
    activeSession = null;
    res.json({ active: false, expiresAt: null });
    return;
  }
  res.json({ active: true, expiresAt: new Date(activeSession.expiresAt).toISOString() });
});

router.post("/dev-testing/start", requireUser, requireRole("admin"), async (_req, res): Promise<void> => {
  if (activeSession && Date.now() < activeSession.expiresAt) {
    res.status(400).json({ error: "A testing session is already active" });
    return;
  }

  const orders = await db.select().from(ordersTable);
  const orderItems = await db.select().from(orderItemsTable);
  const products = await db.select().from(productsTable);

  activeSession = {
    orders,
    orderItems,
    products,
    expiresAt: Date.now() + DURATION_MS,
  };

  res.json({ active: true, expiresAt: new Date(activeSession.expiresAt).toISOString() });
});

router.post("/dev-testing/stop", requireUser, requireRole("admin"), async (_req, res): Promise<void> => {
  if (!activeSession) {
    res.status(400).json({ error: "No active testing session" });
    return;
  }

  const snapshot = activeSession;

  try {
    await db.transaction(async (tx) => {
      // Remove child rows first so foreign keys from order_items -> orders
      // cannot block the restore.
      await tx.delete(orderItemsTable);
      await tx.delete(ordersTable);
      await tx.delete(productsTable);

      // Restore parents before children.
      if (snapshot.orders.length > 0) {
        await tx.insert(ordersTable).values(snapshot.orders);
      }
      if (snapshot.products.length > 0) {
        await tx.insert(productsTable).values(snapshot.products);
      }
      if (snapshot.orderItems.length > 0) {
        await tx.insert(orderItemsTable).values(snapshot.orderItems);
      }
    });

    // Keep the session until the database transaction has succeeded.
    activeSession = null;
    res.json({ restored: true, orderCount: snapshot.orders.length });
  } catch (error) {
    console.error("Dev testing restore failed:", error);
    res.status(500).json({ error: "Failed to restore the testing snapshot" });
  }
});

export default router;
