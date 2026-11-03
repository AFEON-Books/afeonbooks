ALTER TABLE auth_tokens
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS staff_pin_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS staff_security (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pin_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_window_started_at_idx ON auth_rate_limits(window_started_at);

ALTER TABLE site_content
  DROP COLUMN IF EXISTS admin_pin;
