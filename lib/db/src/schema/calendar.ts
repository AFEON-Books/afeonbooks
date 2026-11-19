import { integer, pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const calendarEventsTable = pgTable("calendar_events", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("calendar_events_starts_at_idx").on(table.startsAt),
]);

export type CalendarEventRow = typeof calendarEventsTable.$inferSelect;
