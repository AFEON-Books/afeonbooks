import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const zohoMailConnectionsTable = pgTable("zoho_mail_connections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  emailAddress: text("email_address").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  sessionTokenHash: text("session_token_hash").notNull(),
  unlockedUntil: timestamp("unlocked_until", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const zohoMailOAuthStatesTable = pgTable("zoho_mail_oauth_states", {
  id: serial("id").primaryKey(),
  stateHash: text("state_hash").notNull().unique(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  sessionTokenHash: text("session_token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});