import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  school: text("school").notNull().default("alvarado"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  imageUrl: text("image_url").notNull().default(""),
  stock: integer("stock").notNull().default(0),
  active: boolean("active").notNull().default(true),
  showInShop: boolean("show_in_shop").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProductRow = typeof productsTable.$inferSelect;
