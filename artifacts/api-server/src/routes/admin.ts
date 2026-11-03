import { Router, type IRouter, type RequestHandler } from "express";
import { db, siteContentTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateContent } from "./content";
import { requireRole, requireUser } from "../lib/auth";

const router: IRouter = Router();

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

router.get("/maintenance/status", async (_req, res): Promise<void> => {
  const [content] = await db.select({ maintenanceMode: siteContentTable.maintenanceMode }).from(siteContentTable).limit(1);
  res.set("Cache-Control", "no-store").json({ enabled: content?.maintenanceMode === "true" });
});

router.get("/maintenance/on", requireUser, requireRole("admin"), requireDirectNavigation, async (_req, res): Promise<void> => {
  await setMaintenanceMode(true);
  res.set("Cache-Control", "no-store").json({ enabled: true });
});

router.get("/maintenance/off", requireUser, requireRole("admin"), requireDirectNavigation, async (_req, res): Promise<void> => {
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
