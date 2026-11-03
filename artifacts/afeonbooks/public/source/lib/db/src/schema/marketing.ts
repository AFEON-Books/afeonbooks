import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const bannersTable = pgTable("banners", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  linkUrl: text("link_url").notNull().default(""),
  linkLabel: text("link_label").notNull().default(""),
  backgroundColor: text("background_color").notNull().default("#1F4E46"),
  textColor: text("text_color").notNull().default("#FFFFFF"),
  active: boolean("active").notNull().default(false),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("banners_active_schedule_idx").on(table.active, table.startsAt, table.endsAt)]);

export const promoCodesTable = pgTable("promo_codes", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  discountType: text("discount_type").notNull(),
  discountValue: integer("discount_value").notNull(),
  active: boolean("active").notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  maxUses: integer("max_uses"),
  useCount: integer("use_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("promo_codes_code_unique").on(table.code)]);

export type BannerRow = typeof bannersTable.$inferSelect;
export type PromoCodeRow = typeof promoCodesTable.$inferSelect;