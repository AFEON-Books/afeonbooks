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
