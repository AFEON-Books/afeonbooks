ALTER TABLE sessions
  DROP COLUMN IF EXISTS staff_pin_verified_at;

DROP TABLE IF EXISTS staff_security;
