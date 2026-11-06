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
