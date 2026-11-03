import { Router, type IRouter } from "express";
import {
  db,
  ordersTable,
  orderItemsTable,
  productsTable,
  siteContentTable,
  usersTable,
  loyaltyTransactionsTable,
  promoCodesTable,
  orderAccessTokensTable,
  type OrderRow,
  type OrderItemRow,
} from "@workspace/db";
import {
  CreateOrderBody,
  GetOrderParams,
  GetOrderResponse,
  ListOrdersResponse,
  GetOrdersSummaryResponse,
  UpdateOrderStatusParams,
  UpdateOrderStatusBody,
  UpdateOrderStatusResponse,
  DeleteOrderParams,
} from "@workspace/api-zod";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { sendOrderConfirmation, sendOrderStatusUpdateEmail } from "../lib/email";
import { loadUser, normalizeEmail, requireRole, requireUser } from "../lib/auth";
import { createOrderAccessToken, hasOrderAccess, newOrderAccessToken } from "../lib/order-access";

const router: IRouter = Router();
const CUSTOM_ADDRESS_SHIPPING_FEE_CENTS = 500;
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://afeonbooks.com").replace(/\/+$/, "");

class StockChangedError extends Error {}

router.use("/orders", (_request, response, next) => {
  response.setHeader("Cache-Control", "private, no-store");
  next();
});

function serializeOrder(o: OrderRow, items: OrderItemRow[]) {
  return {
    id: o.id,
    school: o.school,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    customerPhone: o.customerPhone,
    shippingAddress: o.shippingAddress,
    city: o.city,
    postalCode: o.postalCode,
    country: o.country,
    classroom: o.classroom ?? undefined,
    useDefaultAddress: o.useDefaultAddress === "true",
    notes: o.notes ?? undefined,
    customFields: JSON.parse(o.customFields || "{}"),
    paymentMethod: o.paymentMethod,
    orderType: o.orderType,
    paymentStatus: o.paymentStatus,
    status: o.status,
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    shippingCents: o.shippingCents,
    totalCents: o.totalCents,
    currency: o.currency,
    utmSource: o.utmSource ?? undefined,
    utmMedium: o.utmMedium ?? undefined,
    utmCampaign: o.utmCampaign ?? undefined,
    utmTerm: o.utmTerm ?? undefined,
    utmContent: o.utmContent ?? undefined,
    referrer: o.referrer ?? undefined,
    landingPage: o.landingPage ?? undefined,
    estimatedDeliveryDate: o.estimatedDeliveryDate ?? undefined,
    createdAt: o.createdAt.toISOString(),
    items: items.map((it) => ({
      id: it.id,
      productId: it.productId,
      productName: it.productName,
      quantity: it.quantity,
      unitPriceCents: it.unitPriceCents,
    })),
  };
}

router.get("/orders", requireUser, requireRole("staff", "admin"), async (_req, res) => {
  const orders = await db
    .select()
    .from(ordersTable)
    .orderBy(desc(ordersTable.createdAt))
    .limit(200);
  if (orders.length === 0) {
    res.json([]);
    return;
  }
  const items = await db
    .select()
    .from(orderItemsTable)
    .where(
      inArray(
        orderItemsTable.orderId,
        orders.map((o) => o.id),
      ),
    );
  const byOrder = new Map<number, OrderItemRow[]>();
  for (const it of items) {
    const arr = byOrder.get(it.orderId) ?? [];
    arr.push(it);
    byOrder.set(it.orderId, arr);
  }
  res.json(
    ListOrdersResponse.parse(
      orders.map((o) => serializeOrder(o, byOrder.get(o.id) ?? [])),
    ),
  );
});

router.get("/orders/mine", requireUser, async (req, res) => {
  const email = req.user!.email.toLowerCase();
  const orders = await db
    .select()
    .from(ordersTable)
    .where(sql`lower(trim(${ordersTable.customerEmail})) = ${email}`)
    .orderBy(desc(ordersTable.createdAt));

  if (orders.length === 0) {
    res.json([]);
    return;
  }

  const items = await db
    .select()
    .from(orderItemsTable)
    .where(
      inArray(
        orderItemsTable.orderId,
        orders.map((o) => o.id),
      ),
    );

  const byOrder = new Map<number, OrderItemRow[]>();
  for (const it of items) {
    const arr = byOrder.get(it.orderId) ?? [];
    arr.push(it);
    byOrder.set(it.orderId, arr);
  }

  res.json(
    orders.map((o) => serializeOrder(o, byOrder.get(o.id) ?? [])),
  );
});

router.get("/orders/summary", requireUser, requireRole("staff", "admin"), async (_req, res) => {
  const r = (
    await db
      .select({
        totalOrders: sql<number>`cast(count(*) as int)`,
        pendingOrders: sql<number>`cast(count(*) filter (where ${ordersTable.status} = 'pending') as int)`,
        revenueCents: sql<number>`coalesce(cast(sum(${ordersTable.totalCents}) as int), 0)`,
        currency: sql<string | null>`max(${ordersTable.currency})`,
      })
      .from(ordersTable)
  )[0]!;
  res.json(
    GetOrdersSummaryResponse.parse({
      totalOrders: r.totalOrders,
      pendingOrders: r.pendingOrders,
      revenueCents: r.revenueCents,
      currency: r.currency ?? "USD",
    }),
  );
});

router.get("/orders/:id", async (req, res): Promise<void> => {
  const { id } = GetOrderParams.parse(req.params);
  const found = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!found[0]) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const user = await loadUser(req);
  const isStaffOrAdmin = user?.role === "staff" || user?.role === "admin";
  const isOwner = user?.email.toLowerCase() === found[0].customerEmail.toLowerCase();
  const accessToken = req.get("X-Order-Access-Token");
  const hasTokenAccess = accessToken ? await hasOrderAccess(id, accessToken) : false;
  if (!isStaffOrAdmin && !isOwner && !hasTokenAccess) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const items = await db
    .select()
    .from(orderItemsTable)
    .where(eq(orderItemsTable.orderId, id));
  res.json(GetOrderResponse.parse(serializeOrder(found[0], items)));
});

router.post("/orders", async (req, res): Promise<void> => {
  const body = CreateOrderBody.parse(req.body);
  const school = "alvarado";

  let shippingAddress: string;
  let city: string;
  let postalCode: string;
  let country: string;
  let classroom: string | null = null;
  let shipping = CUSTOM_ADDRESS_SHIPPING_FEE_CENTS;

  if (body.useDefaultAddress) {
    const content = (
      await db
        .select()
        .from(siteContentTable)
        .where(eq(siteContentTable.school, school))
        .orderBy(asc(siteContentTable.id))
        .limit(1)
    )[0];
    if (!content) {
      res.status(400).json({
        error:
          "Shipping address is not configured. Please ask the admin to set it up.",
      });
      return;
    }
    const addresses = JSON.parse(content.shippingAddresses || "[]") as {
      id: string;
      label: string;
      address: string;
      city: string;
      postalCode: string;
      country: string;
      shippingFeeCents?: number;
    }[];
    const configuredAddresses = addresses.length > 0
      ? addresses
      : content.defaultShippingAddress &&
          content.defaultShippingCity &&
          content.defaultShippingPostalCode &&
          content.defaultShippingCountry
        ? [{
            id: "legacy-default",
            label: content.defaultShippingLabel || "School Delivery",
            address: content.defaultShippingAddress,
            city: content.defaultShippingCity,
            postalCode: content.defaultShippingPostalCode,
            country: content.defaultShippingCountry,
            shippingFeeCents: 0,
          }]
        : [];
    const selectedAddress = configuredAddresses.find((address) =>
      address.id === (body.shippingAddressId ?? configuredAddresses[0]?.id),
    );
    if (!selectedAddress) {
      res.status(400).json({
        error: "The selected shipping address is no longer available. Please refresh checkout.",
      });
      return;
    }
    if (
      !selectedAddress.address.trim() ||
      !selectedAddress.city.trim() ||
      !selectedAddress.postalCode.trim() ||
      !selectedAddress.country.trim()
    ) {
      res.status(400).json({
        error: "The selected shipping address is incomplete. Please ask the admin to update it.",
      });
      return;
    }
    const trimmedClassroom = (body.classroom ?? "").trim();
    if (!trimmedClassroom) {
      res.status(400).json({ error: "Classroom number is required." });
      return;
    }
    shippingAddress = selectedAddress.address;
    city = selectedAddress.city;
    postalCode = selectedAddress.postalCode;
    country = selectedAddress.country;
    classroom = trimmedClassroom;
    shipping = selectedAddress.shippingFeeCents ?? 0;
  } else {
    const sa = (body.shippingAddress ?? "").trim();
    const ci = (body.city ?? "").trim();
    const pc = (body.postalCode ?? "").trim();
    const co = (body.country ?? "").trim();
    if (!sa || !ci || !pc || !co) {
      res.status(400).json({
        error:
          "Shipping address, city, postal code, and country are required for custom addresses.",
      });
      return;
    }
    shippingAddress = sa;
    city = ci;
    postalCode = pc;
    country = co;
  }

  const requestedQuantities = new Map<number, number>();
  for (const item of body.items) {
    const quantity = (requestedQuantities.get(item.productId) ?? 0) + item.quantity;
    if (!Number.isSafeInteger(quantity) || quantity > 2_147_483_647) {
      res.status(400).json({ error: "Requested product quantity is too large" });
      return;
    }
    requestedQuantities.set(item.productId, quantity);
  }
  const productIds = [...requestedQuantities.keys()];
  const products = await db
    .select()
    .from(productsTable)
    .where(inArray(productsTable.id, productIds));
  const byId = new Map(products.map((p) => [p.id, p]));

  for (const [productId, quantity] of requestedQuantities) {
    const product = byId.get(productId);
    if (!product) {
      res.status(400).json({ error: `Unknown product ${productId}` });
      return;
    }
    if (!product.active) {
      res.status(400).json({ error: `Product ${product.name} is not available` });
      return;
    }
    if (product.stock < quantity) {
      res.status(400).json({ error: `Not enough stock for ${product.name}` });
      return;
    }
  }

  let subtotal = 0;
  const lineItems: { productId: number; productName: string; quantity: number; unitPriceCents: number }[] = [];
  for (const it of body.items) {
    const p = byId.get(it.productId);
    if (!p) continue;
    subtotal += p.priceCents * it.quantity;
    lineItems.push({
      productId: p.id,
      productName: p.name,
      quantity: it.quantity,
      unitPriceCents: p.priceCents,
    });
  }
  const currency = products[0]?.currency ?? "USD";
  const promoCode = body.promoCode?.trim().toUpperCase();
  const accessToken = newOrderAccessToken();

  let created: { order: OrderRow; items: OrderItemRow[]; accessToken: string } | null;
  try {
    created = await db.transaction(async (tx) => {
      let discountCents = 0;
      if (promoCode) {
        const [promo] = await tx
          .select()
          .from(promoCodesTable)
          .where(eq(promoCodesTable.code, promoCode))
          .for("update")
          .limit(1);
        const now = new Date();
        if (
          !promo ||
          !promo.active ||
          (promo.expiresAt !== null && promo.expiresAt <= now) ||
          (promo.maxUses !== null && promo.useCount >= promo.maxUses)
        ) return null;
        discountCents = promo.discountType === "percent"
          ? Math.floor(subtotal * promo.discountValue / 100)
          : Math.min(subtotal, promo.discountValue);
        await tx.update(promoCodesTable).set({ useCount: promo.useCount + 1 }).where(eq(promoCodesTable.id, promo.id));
      }
      for (const [productId, quantity] of [...requestedQuantities].sort(([a], [b]) => a - b)) {
        const [updatedProduct] = await tx
          .update(productsTable)
          .set({ stock: sql`${productsTable.stock} - ${quantity}` })
          .where(and(
            eq(productsTable.id, productId),
            eq(productsTable.active, true),
            gte(productsTable.stock, quantity),
          ))
          .returning({ id: productsTable.id });
        if (!updatedProduct) throw new StockChangedError();
      }
      const total = Math.max(0, subtotal - discountCents) + shipping;
      const inserted = await tx
        .insert(ordersTable)
        .values({
          school,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          customerPhone: body.customerPhone,
          shippingAddress,
          city,
          postalCode,
          country,
          classroom,
          useDefaultAddress: body.useDefaultAddress ? "true" : "false",
          notes: body.notes ?? null,
          customFields: JSON.stringify(body.customFields ?? {}),
          paymentMethod: "cash_on_delivery",
          orderType: body.orderType === "preorder" ? "preorder" : "sale",
          paymentStatus: body.orderType === "preorder" ? "due_later" : "due",
          status: "pending",
          subtotalCents: subtotal,
          discountCents,
          shippingCents: shipping,
          totalCents: total,
          currency,
          utmSource: body.utmSource ?? null,
          utmMedium: body.utmMedium ?? null,
          utmCampaign: body.utmCampaign ?? null,
          utmTerm: body.utmTerm ?? null,
          utmContent: body.utmContent ?? null,
          referrer: body.referrer ?? null,
          landingPage: body.landingPage ?? null,
        })
        .returning();
      const order = inserted[0]!;
      const items = await tx
        .insert(orderItemsTable)
        .values(lineItems.map((li) => ({ ...li, orderId: order.id })))
        .returning();
      await tx.insert(orderAccessTokensTable).values({
        orderId: order.id,
        tokenHash: accessToken.tokenHash,
        expiresAt: accessToken.expiresAt,
      });
      return { order, items, accessToken: accessToken.token };
    });
  } catch (error) {
    if (!(error instanceof StockChangedError)) throw error;
    res.status(409).json({ error: "Stock changed while placing your order. Please refresh and try again." });
    return;
  }

  if (!created) {
    res.status(400).json({ error: "This promo code is invalid or no longer available." });
    return;
  }

  const content = (
    await db
      .select()
      .from(siteContentTable)
      .where(eq(siteContentTable.school, school))
      .orderBy(asc(siteContentTable.id))
      .limit(1)
  )[0];
  if (content) {
    const orderUrl = `${PUBLIC_SITE_URL}/order/${created.order.id}#access_token=${encodeURIComponent(created.accessToken)}`;
    void sendOrderConfirmation({
      content,
      order: created.order,
      items: created.items,
      orderUrl,
    });
  }

  const orderResponse = GetOrderResponse.parse(serializeOrder(created.order, created.items));
  res.status(201).json({ ...orderResponse, accessToken: created.accessToken });
});

router.delete("/orders/:id/access-tokens", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const { id } = GetOrderParams.parse(req.params);
  const revoked = await db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.id, id))
      .for("update");
    if (!order) return false;

    const revokedAt = new Date();
    await tx.update(ordersTable).set({ guestAccessRevokedAt: revokedAt }).where(eq(ordersTable.id, id));
    await tx
      .update(orderAccessTokensTable)
      .set({ revokedAt })
      .where(and(eq(orderAccessTokensTable.orderId, id), isNull(orderAccessTokensTable.revokedAt)));
    return true;
  });
  if (!revoked) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(204).send();
});

router.patch("/orders/:id", requireUser, requireRole("staff", "admin"), async (req, res): Promise<void> => {
  const { id } = UpdateOrderStatusParams.parse(req.params);
  const body = UpdateOrderStatusBody.parse(req.body);
  if (body.status === "shipped" && !body.estimatedDeliveryDate) {
    res.status(400).json({ error: "Estimated delivery date is required when shipping an order" });
    return;
  }
  const estimatedDeliveryDate = body.estimatedDeliveryDate?.toISOString().slice(0, 10);
  let previousStatus: string | undefined;
  const updated = await db.transaction(async (tx) => {
    const current = await tx.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!current[0]) return [];
    previousStatus = current[0].status;

    const changed = await tx
      .update(ordersTable)
      .set({ status: body.status, estimatedDeliveryDate: estimatedDeliveryDate ?? null })
      .where(eq(ordersTable.id, id))
      .returning();

    if (body.status === "delivered" && current[0].status !== body.status) {
      const [user] = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, normalizeEmail(current[0].customerEmail)))
        .limit(1);
      if (user) {
        const existing = await tx
          .select({ id: loyaltyTransactionsTable.id })
          .from(loyaltyTransactionsTable)
          .where(eq(loyaltyTransactionsTable.orderId, id))
          .limit(1);
        if (!existing[0]) {
          const [content] = await tx
            .select({ loyaltyPagesPerDollar: siteContentTable.loyaltyPagesPerDollar })
            .from(siteContentTable)
            .where(eq(siteContentTable.school, "alvarado"))
            .orderBy(asc(siteContentTable.id))
            .limit(1);
          const configuredRate = Number(content?.loyaltyPagesPerDollar ?? 50);
          const pagesPerDollar = Number.isSafeInteger(configuredRate) && configuredRate >= 0 ? configuredRate : 50;
          await tx.insert(loyaltyTransactionsTable).values({
            userId: user.id,
            orderId: id,
            points: Math.floor(current[0].totalCents / 100) * pagesPerDollar,
            description: `Points earned from order #${id}`,
          });
        }
      }
    }
    return changed;
  });
  if (!updated[0]) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const items = await db
    .select()
    .from(orderItemsTable)
    .where(eq(orderItemsTable.orderId, id));
  if (previousStatus !== body.status || estimatedDeliveryDate) {
    const accessToken = await createOrderAccessToken(id);
    void sendOrderStatusUpdateEmail(updated[0], body.status, estimatedDeliveryDate, accessToken);
  }
  res.json(UpdateOrderStatusResponse.parse(serializeOrder(updated[0], items)));
});

router.patch("/orders/:id/edit", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "Order details are required" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const textFields = [
    "customerName",
    "customerEmail",
    "customerPhone",
    "shippingAddress",
    "city",
    "postalCode",
    "country",
    "classroom",
    "notes",
  ] as const;
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  for (const field of textFields) {
    if (typeof body[field] !== "string") {
      res.status(400).json({ error: `${field} must be a string` });
      return;
    }
  }
  const customerName = (body.customerName as string).trim();
  const customerEmail = normalizeEmail(body.customerEmail as string);
  const customerPhone = (body.customerPhone as string).trim();
  const shippingAddress = (body.shippingAddress as string).trim();
  const city = (body.city as string).trim();
  const postalCode = (body.postalCode as string).trim();
  const country = (body.country as string).trim();
  const classroom = (body.classroom as string).trim();
  const notes = (body.notes as string).trim();
  const shippingCents = body.shippingCents;
  const discountCents = body.discountCents;
  if (
    !customerName ||
    !/^\S+@\S+\.\S+$/.test(customerEmail) ||
    !customerPhone ||
    !shippingAddress ||
    !city ||
    !postalCode ||
    !country
  ) {
    res.status(400).json({ error: "Customer and shipping details are required" });
    return;
  }
  if (
    !Number.isSafeInteger(shippingCents) ||
    (shippingCents as number) < 0 ||
    (shippingCents as number) > 2_147_483_647 ||
    !Number.isSafeInteger(discountCents) ||
    (discountCents as number) < 0 ||
    (discountCents as number) > 2_147_483_647
  ) {
    res.status(400).json({ error: "Shipping and discount amounts must be non-negative whole cents" });
    return;
  }

  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, id))
      .for("update")
      .limit(1);
    if (!current) return null;
    if ((discountCents as number) > current.subtotalCents) {
      return { invalidDiscount: true as const };
    }
    const totalCents = current.subtotalCents - (discountCents as number) + (shippingCents as number);
    if (totalCents > 2_147_483_647) {
      return { invalidTotal: true as const };
    }
    const [order] = await tx
      .update(ordersTable)
      .set({
        customerName,
        customerEmail,
        customerPhone,
        shippingAddress,
        city,
        postalCode,
        country,
        classroom: classroom || null,
        notes: notes || null,
        shippingCents: shippingCents as number,
        discountCents: discountCents as number,
        totalCents,
      })
      .where(eq(ordersTable.id, id))
      .returning();
    if (current.status === "delivered") {
      const [earnedTransaction] = await tx
        .select({ id: loyaltyTransactionsTable.id, userId: loyaltyTransactionsTable.userId })
        .from(loyaltyTransactionsTable)
        .where(eq(loyaltyTransactionsTable.orderId, id))
        .limit(1);
      if (earnedTransaction) {
        const [content] = await tx
          .select({ loyaltyPagesPerDollar: siteContentTable.loyaltyPagesPerDollar })
          .from(siteContentTable)
          .where(eq(siteContentTable.school, current.school))
          .orderBy(asc(siteContentTable.id))
          .limit(1);
        const configuredRate = Number(content?.loyaltyPagesPerDollar ?? 50);
        const pagesPerDollar = Number.isSafeInteger(configuredRate) && configuredRate >= 0 ? configuredRate : 50;
        const [matchingUser] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, customerEmail))
          .limit(1);
        await tx
          .update(loyaltyTransactionsTable)
          .set({
            ...(matchingUser ? { userId: matchingUser.id } : {}),
            points: Math.floor(totalCents / 100) * pagesPerDollar,
            description: `Points earned from order #${id}`,
          })
          .where(eq(loyaltyTransactionsTable.id, earnedTransaction.id));
      }
    }
    const items = await tx
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, id));
    return { order, items };
  });
  if (!updated) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if ("invalidDiscount" in updated) {
    res.status(400).json({ error: "Discount cannot exceed the order subtotal" });
    return;
  }
  if ("invalidTotal" in updated) {
    res.status(400).json({ error: "Updated total exceeds the supported maximum" });
    return;
  }
  res.json(GetOrderResponse.parse(serializeOrder(updated.order, updated.items)));
});

router.delete("/orders/:id", requireUser, requireRole("admin"), async (req, res): Promise<void> => {
  const { id } = DeleteOrderParams.parse(req.params);
  const deleted = await db
    .delete(ordersTable)
    .where(eq(ordersTable.id, id))
    .returning({ id: ordersTable.id });
  if (!deleted[0]) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(204).send();
});

export default router;
