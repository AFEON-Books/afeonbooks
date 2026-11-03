CREATE TABLE IF NOT EXISTS "banners" (
  "id" serial PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "link_url" text DEFAULT '' NOT NULL,
  "link_label" text DEFAULT '' NOT NULL,
  "background_color" text DEFAULT '#1F4E46' NOT NULL,
  "text_color" text DEFAULT '#FFFFFF' NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "banners_active_schedule_idx"
  ON "banners" USING btree ("active", "starts_at", "ends_at");

CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id" serial PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "discount_type" text NOT NULL,
  "discount_value" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "expires_at" timestamp with time zone,
  "max_uses" integer,
  "use_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_code_unique"
  ON "promo_codes" USING btree ("code");
