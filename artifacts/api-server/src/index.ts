import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function ensureOrderColumns() {
  // The production Supabase database was created before these fields existed.
  // Keep startup self-healing so the Drizzle schema matches the live database.
  await pool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS school text NOT NULL DEFAULT 'alvarado',
      ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'sale',
      ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'due',
      ADD COLUMN IF NOT EXISTS estimated_delivery_date text,
      ADD COLUMN IF NOT EXISTS discount_cents integer NOT NULL DEFAULT 0
  `);
  await pool.query(`
      UPDATE orders
      SET discount_cents = GREATEST(subtotal_cents + shipping_cents - total_cents, 0)
      WHERE discount_cents = 0 AND total_cents < subtotal_cents + shipping_cents
  `);
  logger.info("Verified orders.order_type, orders.payment_status, and orders.discount_cents columns");
}

async function ensureContentColumns() {
  await pool.query(`
    ALTER TABLE site_content
      ADD COLUMN IF NOT EXISTS school text NOT NULL DEFAULT 'alvarado',
      ADD COLUMN IF NOT EXISTS orders_enabled text NOT NULL DEFAULT 'true',
      ADD COLUMN IF NOT EXISTS maintenance_mode text NOT NULL DEFAULT 'false',
      ADD COLUMN IF NOT EXISTS checkout_fields text NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS shipping_addresses text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS loyalty_pages_per_dollar text NOT NULL DEFAULT '50',
      ADD COLUMN IF NOT EXISTS blog_title text NOT NULL DEFAULT 'Progress Update',
      ADD COLUMN IF NOT EXISTS blog_subtitle text NOT NULL DEFAULT 'A look inside the latest adventure from the AFEON Books team.',
      ADD COLUMN IF NOT EXISTS blog_date text NOT NULL DEFAULT 'September 15, 2026',
      ADD COLUMN IF NOT EXISTS blog_hero_image_url text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS faqs text NOT NULL DEFAULT '[{"question":"How do I place an order?","answer":"Browse the shop, add an available item to your cart, and continue to checkout when you are ready."},{"question":"How can I check my cart?","answer":"Select the shopping bag in the header to open your cart and review its contents."},{"question":"What does it mean if an item is out of stock?","answer":"Items marked out of stock cannot currently be added to your cart."},{"question":"Where can I learn more about the book?","answer":"The About section on the home page has more information about the book and its creators."},{"question":"How do I access my account?","answer":"Choose Sign in in the header to open the account page."}]',
      ADD COLUMN IF NOT EXISTS blog_body text NOT NULL DEFAULT 'We are back at the writing table, building the next mystery one clue at a time.

The next book is taking shape with bigger questions, stranger discoveries, and a brand-new trail for our detectives to follow. We cannot wait to share more soon.'
  `);
  await pool.query(`
    UPDATE site_content AS target
    SET shipping_addresses = COALESCE((
      SELECT json_agg(json_build_object(
        'id', 'legacy-' || legacy.school,
        'label', COALESCE(NULLIF(legacy.default_shipping_label, ''), 'School Delivery'),
        'address', legacy.default_shipping_address,
        'city', legacy.default_shipping_city,
        'postalCode', legacy.default_shipping_postal_code,
        'country', legacy.default_shipping_country
      ) ORDER BY legacy.id)::text
      FROM (
        SELECT DISTINCT ON (school)
          id, school, default_shipping_label, default_shipping_address,
          default_shipping_city, default_shipping_postal_code, default_shipping_country
        FROM site_content
        WHERE school IN ('alvarado', 'shelyn')
          AND default_shipping_address <> ''
          AND default_shipping_city <> ''
          AND default_shipping_postal_code <> ''
          AND default_shipping_country <> ''
        ORDER BY school, id
      ) AS legacy
    ), '[]')
    WHERE target.id = (
      SELECT id FROM site_content WHERE school = 'alvarado' ORDER BY id LIMIT 1
    )
      AND target.shipping_addresses = ''
  `);
  await pool.query(`
    UPDATE site_content SET shipping_addresses = '[]'
    WHERE shipping_addresses = ''
  `);
  logger.info("Verified site_content compatibility columns");
}

async function ensureProductColumns() {
  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS show_in_shop boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0
  `);
  await pool.query(`
    WITH ranked_products AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) - 1 AS position
      FROM products
    )
    UPDATE products
    SET sort_order = ranked_products.position
    FROM ranked_products
    WHERE products.id = ranked_products.id
      AND NOT EXISTS (SELECT 1 FROM products WHERE sort_order <> 0)
  `);
  logger.info("Verified products.show_in_shop and products.sort_order columns");
}

async function ensureAuthTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      name text NOT NULL,
      role text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
    CREATE TABLE IF NOT EXISTS sessions (
      id serial PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      type text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS auth_tokens_user_type_idx ON auth_tokens(user_id, type);
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      key text PRIMARY KEY,
      window_started_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS auth_rate_limits_window_started_at_idx ON auth_rate_limits(window_started_at);
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_id integer,
      points integer NOT NULL,
      description text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS loyalty_transactions_user_id_idx ON loyalty_transactions(user_id);
  `);
  logger.info("Verified auth tables");
}

async function ensureMailTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zoho_mail_connections (
      id serial PRIMARY KEY,
      user_id integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      account_id text NOT NULL,
      email_address text NOT NULL,
      encrypted_refresh_token text NOT NULL,
      session_token_hash text NOT NULL,
      unlocked_until timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS zoho_mail_oauth_states (
      id serial PRIMARY KEY,
      state_hash text NOT NULL UNIQUE,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS zoho_mail_oauth_states_expiry_idx ON zoho_mail_oauth_states(expires_at);
  `);
  logger.info("Verified Zoho Mail tables");
}

await ensureOrderColumns();
await ensureContentColumns();
await ensureProductColumns();
await ensureAuthTables();
await ensureMailTables();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
