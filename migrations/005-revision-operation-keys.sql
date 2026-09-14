-- Revisions are the atomic receipt for internal Workflow write/append retries.
-- Normal interactive and MCP writes leave this key null.
ALTER TABLE brain_revisions ADD COLUMN operation_key text
  CHECK (operation_key IS NULL OR char_length(operation_key) BETWEEN 1 AND 256);

CREATE UNIQUE INDEX brain_revisions_operation_key_idx
  ON brain_revisions (owner_id, operation_key)
  WHERE operation_key IS NOT NULL;
