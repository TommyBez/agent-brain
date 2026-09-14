CREATE TABLE brain_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('consolidation', 'export')),
  run_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_id uuid,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, kind, run_date)
);
CREATE INDEX brain_jobs_pending_idx ON brain_jobs (owner_id, status, created_at);
