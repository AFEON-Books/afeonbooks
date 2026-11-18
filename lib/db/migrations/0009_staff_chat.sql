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
