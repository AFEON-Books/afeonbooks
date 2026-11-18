import { Router, type IRouter } from "express";
import { db, siteContentTable, type SiteContentRow } from "@workspace/db";
import { UpdateContentBody, GetContentResponse } from "@workspace/api-zod";
import { asc, eq } from "drizzle-orm";
import { requireRole, requireUser } from "../lib/auth";

const router: IRouter = Router();

const DEFAULT_FAQS = [
  {
    question: "How do I place an order?",
    answer:
      "Browse the shop, add an available item to your cart, and continue to checkout when you are ready.",
  },
  {
    question: "How can I check my cart?",
    answer:
      "Select the shopping bag in the header to open your cart and review its contents.",
  },
  {
    question: "What does it mean if an item is out of stock?",
    answer: "Items marked out of stock cannot currently be added to your cart.",
  },
  {
    question: "Where can I learn more about the book?",
    answer:
      "The About section on the home page has more information about the book and its creators.",
  },
  {
    question: "How do I access my account?",
    answer: "Choose Sign in in the header to open the account page.",
  },
];

const DEFAULT_CONTENT = {
  brandName: "AFEON Books",
  navHomeLabel: "Home",
  heroTitle: "The Terror Of The Evil Capybara",
  heroSubtitle: "Written by 6th Graders.",
  ctaLabel: "Shop Now",
  ctaUrl: "/shop",
  coverImageUrl:
    "https://static.wixstatic.com/media/91d5eb_b2c9e6441ca74cf0ad33c5b8935b9ffe~mv2.jpg/v1/fill/w_584,h_751,al_c,q_85,usm_0.66_1.00_0.01/91d5eb_b2c9e6441ca74cf0ad33c5b8935b9ffe~mv2.jpg",
  aboutHeading: "The Terror Of The Evil Capybara - Book 1",
  aboutBody:
    "When terror reveals itself to the detectives, it comes in the form of a fury little capybara with glasses. What happens when these two enemies go head to head? Who will win the duel? Good? Or evil? Join the detectives, White Dragon, Evanzilla, Naomi Da Apple and Kevin as they try to win the battle against evil and also do dangerous things while at it, like jumping off skyscrapers.",
  faqs: JSON.stringify(DEFAULT_FAQS),
  authorsLine: "Francis Kawibawa, Naomi Tsao, Olivia Chang, Evan Lee.",
  illustratorLine: "Janis Vong",
  footerNote: "© 2026 AFR Group. All Rights Reserved.",
  accentColor: "#E2553B",
  homeSectionOrder: JSON.stringify(["hero", "shop", "about", "faq"]),
  homeCustomSections: "[]",
  defaultShippingLabel: "School Delivery",
  defaultShippingAddress: "",
  defaultShippingCity: "",
  defaultShippingPostalCode: "",
  defaultShippingCountry: "",
  shippingAddresses: "[]",
  loyaltyPagesPerDollar: "50",
  checkoutFields: "[]",
  blogTitle: "Progress Update",
  blogSubtitle: "A look inside the latest adventure from the AFEON Books team.",
  blogDate: "September 15, 2026",
  blogHeroImageUrl: "",
  blogBody:
    "We are back at the writing table, building the next mystery one clue at a time.\n\nBook 6 is taking shape with bigger questions, stranger discoveries, and a brand-new trail for our detectives to follow. We cannot wait to share more soon.",
};

export function serializeContent(row: SiteContentRow) {
  const savedShippingAddresses = JSON.parse(row.shippingAddresses || "[]") as {
    id: string;
    label: string;
    address: string;
    city: string;
    postalCode: string;
    country: string;
    shippingFeeCents?: number;
  }[];
  const shippingAddresses = savedShippingAddresses.map((address) => ({
    ...address,
    shippingFeeCents: address.shippingFeeCents ?? 0,
  }));
  const legacyAddressConfigured = Boolean(
    row.defaultShippingAddress &&
    row.defaultShippingCity &&
    row.defaultShippingPostalCode &&
    row.defaultShippingCountry,
  );
  return {
    id: row.id,
    school: row.school,
    brandName: row.brandName,
    navHomeLabel: row.navHomeLabel,
    heroTitle: row.heroTitle,
    heroSubtitle: row.heroSubtitle,
    ctaLabel: row.ctaLabel,
    ctaUrl: row.ctaUrl,
    coverImageUrl: row.coverImageUrl,
    aboutHeading: row.aboutHeading,
    aboutBody: row.aboutBody,
    faqs: JSON.parse(row.faqs || "[]"),
    authorsLine: row.authorsLine,
    illustratorLine: row.illustratorLine,
    footerNote: row.footerNote,
    accentColor: row.accentColor,
    homeSectionOrder: JSON.parse(
      row.homeSectionOrder || '["hero","shop","about","faq"]',
    ),
    homeCustomSections: JSON.parse(row.homeCustomSections || "[]"),
    defaultShippingLabel: row.defaultShippingLabel,
    defaultShippingAddress: row.defaultShippingAddress,
    defaultShippingCity: row.defaultShippingCity,
    defaultShippingPostalCode: row.defaultShippingPostalCode,
    defaultShippingCountry: row.defaultShippingCountry,
    shippingAddresses:
      shippingAddresses.length > 0
        ? shippingAddresses
        : legacyAddressConfigured
          ? [
              {
                id: "legacy-default",
                label: row.defaultShippingLabel || "School Delivery",
                address: row.defaultShippingAddress,
                city: row.defaultShippingCity,
                postalCode: row.defaultShippingPostalCode,
                country: row.defaultShippingCountry,
                shippingFeeCents: 0,
              },
            ]
          : [],
    loyaltyPagesPerDollar: Number(row.loyaltyPagesPerDollar),
    ordersEnabled: row.ordersEnabled === "true",
    emailEnabled: row.emailEnabled === "true",
    emailFromName: row.emailFromName,
    emailFromAddress: row.emailFromAddress,
    emailReplyTo: row.emailReplyTo,
    emailSubject: row.emailSubject,
    emailHeading: row.emailHeading,
    emailIntro: row.emailIntro,
    emailButtonLabel: row.emailButtonLabel,
    emailFooter: row.emailFooter,
    emailAccentColor: row.emailAccentColor,
    checkoutFields: JSON.parse(row.checkoutFields || "[]"),
    blogTitle: row.blogTitle,
    blogSubtitle: row.blogSubtitle,
    blogDate: row.blogDate,
    blogHeroImageUrl: row.blogHeroImageUrl,
    blogBody: row.blogBody,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getOrCreateContent(): Promise<SiteContentRow> {
  const existing = await db
    .select()
    .from(siteContentTable)
    .where(eq(siteContentTable.school, "alvarado"))
    .orderBy(asc(siteContentTable.id))
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(siteContentTable)
    .values({ ...DEFAULT_CONTENT, school: "alvarado" })
    .returning();
  return inserted[0]!;
}

router.get("/content", async (_req, res) => {
  const row = await getOrCreateContent();
  res.json(GetContentResponse.parse(serializeContent(row)));
});

router.put("/content", requireUser, requireRole("admin"), async (req, res) => {
  const body = UpdateContentBody.parse(req.body);
  const customSectionIds = body.homeCustomSections.map((section) => section.id);
  const allowedSections = new Set([
    "hero",
    "shop",
    "about",
    "faq",
    ...customSectionIds,
  ]);
  const customCodeSize = body.homeCustomSections.reduce(
    (total, section) =>
      total + section.html.length + section.css.length + section.js.length,
    0,
  );
  if (
    body.homeCustomSections.length > 10 ||
    customCodeSize > 50_000 ||
    customSectionIds.some((id) => !id.startsWith("custom-")) ||
    new Set(customSectionIds).size !== customSectionIds.length ||
    body.homeSectionOrder.length !== allowedSections.size ||
    new Set(body.homeSectionOrder).size !== body.homeSectionOrder.length ||
    body.homeSectionOrder.some((section) => !allowedSections.has(section))
  ) {
    res
      .status(400)
      .json({ error: "Invalid homepage section layout or custom code size" });
    return;
  }
  const current = await getOrCreateContent();
  const {
    ordersEnabled,
    emailEnabled,
    checkoutFields,
    loyaltyPagesPerDollar,
    faqs,
    homeSectionOrder,
    homeCustomSections,
    ...rest
  } = body;
  const updated = await db
    .update(siteContentTable)
    .set({
      ...rest,
      ordersEnabled: ordersEnabled ? "true" : "false",
      emailEnabled: emailEnabled ? "true" : "false",
      checkoutFields: JSON.stringify(checkoutFields ?? []),
      ...(faqs !== undefined ? { faqs: JSON.stringify(faqs) } : {}),
      homeSectionOrder: JSON.stringify(homeSectionOrder),
      homeCustomSections: JSON.stringify(homeCustomSections),
      shippingAddresses: JSON.stringify(
        (body.shippingAddresses ?? []).map((address) => ({
          ...address,
          shippingFeeCents: address.shippingFeeCents ?? 0,
        })),
      ),
      loyaltyPagesPerDollar: String(loyaltyPagesPerDollar ?? 50),
      ...(body.shippingAddresses !== undefined
        ? {
            defaultShippingLabel: "",
            defaultShippingAddress: "",
            defaultShippingCity: "",
            defaultShippingPostalCode: "",
            defaultShippingCountry: "",
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(siteContentTable.id, current.id))
    .returning();
  res.json(GetContentResponse.parse(serializeContent(updated[0]!)));
});

export default router;
