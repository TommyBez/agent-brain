CREATE TABLE agent_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['brain:read','brain:write','brain:maintain']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX agent_tokens_owner_idx ON agent_tokens(owner_id, created_at DESC);
