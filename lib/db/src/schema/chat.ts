import { boolean, integer, pgTable, primaryKey, serial, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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

export const chatRoomsTable = pgTable("chat_rooms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("chat_rooms_type_created_at_idx").on(table.type, table.createdAt),
  uniqueIndex("chat_rooms_channel_name_unique").on(sql`lower(${table.name})`).where(sql`${table.type} = 'channel'`),
]);

export const chatRoomMembersTable = pgTable("chat_room_members", {
  roomId: integer("room_id").notNull().references(() => chatRoomsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.roomId, table.userId] }),
  index("chat_room_members_user_idx").on(table.userId),
]);

export const chatRoomMessagesTable = pgTable("chat_room_messages", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id").notNull().references(() => chatRoomsTable.id, { onDelete: "cascade" }),
  senderUserId: integer("sender_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("chat_room_messages_room_created_idx").on(table.roomId, table.createdAt, table.id),
]);

export const chatRoomWebhooksTable = pgTable("chat_room_webhooks", {
  roomId: integer("room_id").primaryKey().references(() => chatRoomsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  encryptedSecret: text("encrypted_secret"),
  mtlsEnabled: boolean("mtls_enabled").notNull().default(false),
  encryptedClientCertificate: text("encrypted_client_certificate"),
  encryptedClientKey: text("encrypted_client_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportConversationsTable = pgTable("support_conversations", {
  id: serial("id").primaryKey(),
  customerTokenHash: text("customer_token_hash").notNull().unique(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastCustomerMessageAt: timestamp("last_customer_message_at", { withTimezone: true }),
  lastStaffReadAt: timestamp("last_staff_read_at", { withTimezone: true }),
}, (table) => [
  index("support_conversations_status_updated_idx").on(table.status, table.updatedAt),
]);

export const supportMessagesTable = pgTable("support_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => supportConversationsTable.id, { onDelete: "cascade" }),
  senderType: text("sender_type").notNull(),
  senderUserId: integer("sender_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("support_messages_conversation_created_idx").on(table.conversationId, table.createdAt, table.id),
]);
