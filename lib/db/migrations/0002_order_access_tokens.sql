ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "guest_access_revoked_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "order_access_tokens" (
  "id" serial PRIMARY KEY NOT NULL,
  "order_id" integer NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "order_access_tokens_token_hash_unique"
  ON "order_access_tokens" USING btree ("token_hash");

CREATE INDEX IF NOT EXISTS "order_access_tokens_order_expiry_idx"
  ON "order_access_tokens" USING btree ("order_id", "expires_at");
