import { and, eq, gt, lt, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { calendarEventsTable, db, usersTable } from "@workspace/db";
import { requireStaffAccess, requireUser } from "../lib/auth";

const router: IRouter = Router();
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_RANGE_MS = 93 * 24 * 60 * 60 * 1_000;

function parseId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length > 50) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseEventInput(body: unknown) {
  if (!body || typeof body !== "object") return undefined;
  const input = body as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const startsAt = parseDate(input.startsAt);
  const endsAt = parseDate(input.endsAt);
  if (
    title.length < 1 ||
    title.length > MAX_TITLE_LENGTH ||
    description.length > MAX_DESCRIPTION_LENGTH ||
    !startsAt ||
    !endsAt ||
    endsAt <= startsAt
  ) return undefined;
  return { title, description, startsAt, endsAt };
}

router.use("/calendar", (_request, response, next) => {
  response.setHeader("Cache-Control", "private, no-store");
  next();
});

router.get("/calendar/events", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const start = parseDate(request.query.start);
  const end = parseDate(request.query.end);
  if (!start || !end || end <= start || end.getTime() - start.getTime() > MAX_RANGE_MS) {
    response.status(400).json({ error: "Choose a calendar date range of up to 93 days." });
    return;
  }
  const events = await db.select({
    id: calendarEventsTable.id,
    title: calendarEventsTable.title,
    description: calendarEventsTable.description,
    startsAt: calendarEventsTable.startsAt,
    endsAt: calendarEventsTable.endsAt,
    createdBy: calendarEventsTable.createdBy,
    createdAt: calendarEventsTable.createdAt,
    updatedAt: calendarEventsTable.updatedAt,
    creatorName: usersTable.name,
  })
    .from(calendarEventsTable)
    .leftJoin(usersTable, eq(calendarEventsTable.createdBy, usersTable.id))
    .where(and(
      gt(calendarEventsTable.endsAt, start),
      lt(calendarEventsTable.startsAt, end),
    ))
    .orderBy(calendarEventsTable.startsAt);
  response.json({
    events,
    currentUserId: request.user!.id,
    currentUserRole: request.user!.role,
  });
});

router.post("/calendar/events", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const input = parseEventInput(request.body);
  if (!input) {
    response.status(400).json({ error: `Enter a title of 1 to ${MAX_TITLE_LENGTH} characters, a description of at most ${MAX_DESCRIPTION_LENGTH} characters, and a valid end time after the start.` });
    return;
  }
  const [event] = await db.insert(calendarEventsTable)
    .values({ ...input, createdBy: request.user!.id })
    .returning();
  response.status(201).json({ event });
});

router.put("/calendar/events/:id", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const id = parseId(request.params.id);
  const input = parseEventInput(request.body);
  if (!id || !input) {
    response.status(400).json({ error: "Choose a valid event and enter its title, description, and times." });
    return;
  }
  const where = request.user!.role === "admin"
    ? eq(calendarEventsTable.id, id)
    : and(
      eq(calendarEventsTable.id, id),
      eq(calendarEventsTable.createdBy, request.user!.id),
    );
  const [event] = await db.update(calendarEventsTable)
    .set({ ...input, updatedAt: new Date() })
    .where(where)
    .returning();
  if (!event) {
    response.status(404).json({ error: "Calendar event not found." });
    return;
  }
  response.json({ event });
});

router.delete("/calendar/events/:id", requireUser, requireStaffAccess("staff", "admin"), async (request, response): Promise<void> => {
  const id = parseId(request.params.id);
  if (!id) {
    response.status(400).json({ error: "Choose a valid calendar event." });
    return;
  }
  const where = request.user!.role === "admin"
    ? eq(calendarEventsTable.id, id)
    : and(
      eq(calendarEventsTable.id, id),
      eq(calendarEventsTable.createdBy, request.user!.id),
    );
  const [deleted] = await db.delete(calendarEventsTable)
    .where(where)
    .returning({ id: calendarEventsTable.id });
  if (!deleted) {
    response.status(404).json({ error: "Calendar event not found." });
    return;
  }
  response.status(204).end();
});

export default router;
