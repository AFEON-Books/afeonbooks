import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { attachChatWebSocket } from "./routes/chat";

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
      ADD COLUMN IF NOT EXISTS home_section_order text NOT NULL DEFAULT '["hero","shop","about","faq"]',
      ADD COLUMN IF NOT EXISTS home_custom_sections text NOT NULL DEFAULT '[]',
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
      expires_at timestamptz NOT NULL,
      github_user_id text
    );
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS github_user_id text;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS github_authenticated_at timestamptz;
    CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
    CREATE TABLE IF NOT EXISTS github_account_links (
      id serial PRIMARY KEY,
      github_username text NOT NULL,
      github_user_id text,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS github_account_links_username_unique
      ON github_account_links (lower(github_username));
    CREATE UNIQUE INDEX IF NOT EXISTS github_account_links_github_user_id_unique
      ON github_account_links (github_user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS github_account_links_user_id_unique
      ON github_account_links (user_id);
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

async function ensureChatTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_presence (
      user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_seen_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_presence_last_seen_at_idx
      ON chat_presence (last_seen_at);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id serial PRIMARY KEY,
      sender_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
      ON chat_messages (sender_user_id, recipient_user_id, created_at);
  `);
  logger.info("Verified staff chat tables");
}

async function ensureCustomerAndRoomChatTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      id serial PRIMARY KEY,
      name text NOT NULL,
      type text NOT NULL CHECK (type IN ('channel', 'group')),
      created_by integer REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_rooms_type_created_at_idx
      ON chat_rooms (type, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_channel_name_unique
      ON chat_rooms (lower(name)) WHERE type = 'channel';
    CREATE TABLE IF NOT EXISTS chat_room_members (
      room_id integer NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS chat_room_members_user_idx
      ON chat_room_members (user_id);
    CREATE TABLE IF NOT EXISTS chat_room_messages (
      id serial PRIMARY KEY,
      room_id integer NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
      sender_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_room_messages_room_created_idx
      ON chat_room_messages (room_id, created_at, id);
    CREATE TABLE IF NOT EXISTS chat_room_webhooks (
      room_id integer PRIMARY KEY REFERENCES chat_rooms(id) ON DELETE CASCADE,
      name text NOT NULL,
      url text NOT NULL,
      encrypted_secret text,
      mtls_enabled boolean NOT NULL DEFAULT false,
      encrypted_client_certificate text,
      encrypted_client_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS support_conversations (
      id serial PRIMARY KEY,
      customer_token_hash text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_customer_message_at timestamptz,
      last_staff_read_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS support_conversations_status_updated_idx
      ON support_conversations (status, updated_at);
    CREATE TABLE IF NOT EXISTS support_messages (
      id serial PRIMARY KEY,
      conversation_id integer NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
      sender_type text NOT NULL CHECK (sender_type IN ('customer', 'staff')),
      sender_user_id integer REFERENCES users(id) ON DELETE SET NULL,
      message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS support_messages_conversation_created_idx
      ON support_messages (conversation_id, created_at, id);
  `);
  await pool.query(`
    INSERT INTO chat_rooms (name, type, created_by)
    SELECT 'general', 'channel', MIN(users.id)
    FROM users
    WHERE users.role IN ('staff', 'admin')
      AND NOT EXISTS (
        SELECT 1 FROM chat_rooms WHERE type = 'channel' AND lower(name) = 'general'
      )
    HAVING COUNT(*) > 0
    ON CONFLICT DO NOTHING
  `);
  logger.info("Verified customer support and staff room chat tables");
}

async function ensureCalendarEventsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id serial PRIMARY KEY,
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      created_by integer REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at)
    );
    CREATE INDEX IF NOT EXISTS calendar_events_starts_at_idx
      ON calendar_events (starts_at);
  `);
  logger.info("Verified staff calendar events table");
}

await ensureOrderColumns();
await ensureContentColumns();
await ensureProductColumns();
await ensureAuthTables();
await ensureMailTables();
await ensureChatTables();
await ensureCustomerAndRoomChatTables();
await ensureCalendarEventsTable();

const server = createServer(app);
attachChatWebSocket(server);
server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
