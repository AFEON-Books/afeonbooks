import { integer, pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const chatPresenceTable = pgTable("chat_presence", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("chat_presence_last_seen_at_idx").on(table.lastSeenAt),
]);

export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  senderUserId: integer("sender_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  recipientUserId: integer("recipient_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("chat_messages_conversation_idx").on(table.senderUserId, table.recipientUserId, table.createdAt),
]);
