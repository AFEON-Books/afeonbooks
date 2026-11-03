ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS github_user_id text;
