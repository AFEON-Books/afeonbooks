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
