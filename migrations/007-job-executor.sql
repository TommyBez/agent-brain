-- Keep GitHub-runner history separate from Workflow's daily execution state.
-- This permits the first Workflow pass on the cutover day without rewriting
-- or falsely reusing the previous executor's completion receipt.
ALTER TABLE brain_jobs
  ADD COLUMN executor text NOT NULL DEFAULT 'workflow'
    CHECK (executor IN ('github', 'workflow'));

UPDATE brain_jobs SET executor='github' WHERE workflow_run_id IS NULL;

ALTER TABLE brain_jobs
  DROP CONSTRAINT brain_jobs_owner_id_kind_run_date_key,
  ADD CONSTRAINT brain_jobs_owner_kind_date_executor_key
    UNIQUE (owner_id,kind,run_date,executor);
