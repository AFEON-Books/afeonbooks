import { index, pgTable, serial, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const ordersTable = pgTable("orders", {
  id: serial("id").primaryKey(),
  school: text("school").notNull().default("alvarado"),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone").notNull(),
  shippingAddress: text("shipping_address").notNull(),
  city: text("city").notNull(),
  postalCode: text("postal_code").notNull(),
  country: text("country").notNull(),
  classroom: text("classroom"),
  useDefaultAddress: text("use_default_address").notNull().default("false"),
  notes: text("notes"),
  customFields: text("custom_fields").notNull().default("{}"),
  paymentMethod: text("payment_method").notNull().default("cash_on_delivery"),
  orderType: text("order_type").notNull().default("sale"),
  paymentStatus: text("payment_status").notNull().default("due"),
  status: text("status").notNull().default("pending"),
  estimatedDeliveryDate: text("estimated_delivery_date"),
  subtotalCents: integer("subtotal_cents").notNull(),
  discountCents: integer("discount_cents").notNull().default(0),
  shippingCents: integer("shipping_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),
  referrer: text("referrer"),
  landingPage: text("landing_page"),
  guestAccessRevokedAt: timestamp("guest_access_revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderAccessTokensTable = pgTable("order_access_tokens", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => ordersTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("order_access_tokens_token_hash_unique").on(table.tokenHash),
  index("order_access_tokens_order_expiry_idx").on(table.orderId, table.expiresAt),
]);

export const orderItemsTable = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => ordersTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull(),
  productName: text("product_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
});

export type OrderRow = typeof ordersTable.$inferSelect;
export type OrderItemRow = typeof orderItemsTable.$inferSelect;
