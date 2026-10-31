import { Router, type IRouter, type RequestHandler } from "express";
import { db, siteContentTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateContent } from "./content";
import { requireRole, requireUser } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const attempts: Map<string, { count: number; lockedUntil: number }> = new Map();

const requireDirectNavigation: RequestHandler = (req, res, next) => {
  if (req.get("sec-fetch-site") !== "none" || req.get("sec-fetch-mode") !== "navigate") {
    res.status(403).json({ error: "Open this URL directly in your browser to change maintenance mode" });
    return;
  }
  next();
};

async function setMaintenanceMode(enabled: boolean): Promise<void> {
  const content = await getOrCreateContent();
  await db
    .update(siteContentTable)
    .set({ maintenanceMode: enabled ? "true" : "false" })
    .where(eq(siteContentTable.id, content.id));
}

router.post("/admin/verify-pin", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const record = attempts.get(ip) ?? { count: 0, lockedUntil: 0 };

  if (record.lockedUntil > now) {
    const secs = Math.ceil((record.lockedUntil - now) / 1000);
    if (process.env.DEV_AUDIT_LOGS === "true") logger.warn({ audit: true, event: "admin_pin_locked", ip }, "dev_audit");
    res.status(429).json({ error: `Too many attempts. Try again in ${secs}s.` });
    return;
  }

  const { pin } = req.body as { pin?: unknown };
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    if (process.env.DEV_AUDIT_LOGS === "true") logger.warn({ audit: true, event: "admin_pin_invalid_format", digits: typeof pin === "string" ? pin.length : 0, ip }, "dev_audit");
    res.status(400).json({ error: "PIN must be exactly 4 digits" });
    return;
  }

  const content = await getOrCreateContent();
  const success = content.adminPin === pin;
  if (process.env.DEV_AUDIT_LOGS === "true") logger.info({ audit: true, event: "admin_pin_attempt", success, digits: pin.length, ip }, "dev_audit");

  if (success) {
    attempts.delete(ip);
    res.json({ success: true });
  } else {
    record.count += 1;
    if (record.count >= 5) {
      record.lockedUntil = now + 30_000;
      record.count = 0;
    }
    attempts.set(ip, record);
    res.json({ success: false });
  }
});

router.put("/admin/pin", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const { newPin } = req.body as { newPin?: unknown };
  if (typeof newPin !== "string" || !/^\d{4}$/.test(newPin)) {
    res.status(400).json({ error: "PIN must be exactly 4 digits" });
    return;
  }
  if (process.env.DEV_AUDIT_LOGS === "true") logger.info({ audit: true, event: "admin_pin_changed", ip: req.ip }, "dev_audit");
  const content = await getOrCreateContent();
  await db
    .update(siteContentTable)
    .set({ adminPin: newPin })
    .where(eq(siteContentTable.id, content.id));
  res.json({ success: true });
});

router.get("/maintenance/status", async (_req, res): Promise<void> => {
  const [content] = await db.select({ maintenanceMode: siteContentTable.maintenanceMode }).from(siteContentTable).limit(1);
  res.set("Cache-Control", "no-store").json({ enabled: content?.maintenanceMode === "true" });
});

router.get("/maintence/on", requireUser, requireRole("admin"), requireDirectNavigation, async (_req, res): Promise<void> => {
  await setMaintenanceMode(true);
  res.set("Cache-Control", "no-store").json({ enabled: true });
});

router.get("/maintence/off", requireUser, requireRole("admin"), requireDirectNavigation, async (_req, res): Promise<void> => {
  await setMaintenanceMode(false);
  res.set("Cache-Control", "no-store").json({ enabled: false });
});

router.post("/admin/maintenance", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  await setMaintenanceMode(enabled);
  res.json({ enabled });
});

export default router;
