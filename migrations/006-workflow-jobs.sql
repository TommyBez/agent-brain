-- Keep prior runner history while durable Workflow takes over execution.
ALTER TABLE brain_jobs
  DROP CONSTRAINT brain_jobs_kind_check,
  ADD CONSTRAINT brain_jobs_kind_check
    CHECK (kind IN ('consolidation', 'embeddings', 'export')),
  DROP CONSTRAINT brain_jobs_status_check,
  ADD CONSTRAINT brain_jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  ADD COLUMN workflow_run_id text
    CHECK (workflow_run_id IS NULL OR char_length(workflow_run_id) BETWEEN 1 AND 256);
