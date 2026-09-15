-- Retire unstarted work owned by the disabled GitHub runner. Other historical
-- results, including any in-flight job, keep their recorded state.
ALTER TABLE brain_jobs
  DROP CONSTRAINT brain_jobs_status_check,
  ADD CONSTRAINT brain_jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'));

UPDATE brain_jobs
SET status='cancelled',
    finished_at=now(),
    error='Superseded by Vercel Workflow before execution.'
WHERE executor='github' AND status='queued';
