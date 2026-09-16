-- Workflow is the sole executor. Discard retired runner history and cancelled
-- jobs from either executor before restoring daily uniqueness and status checks.
DELETE FROM "brain_jobs" WHERE "executor" = 'github' OR "status" = 'cancelled';
--> statement-breakpoint
ALTER TABLE "brain_migrations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "brain_migrations" CASCADE;--> statement-breakpoint
ALTER TABLE "brain_jobs" DROP CONSTRAINT "brain_jobs_owner_kind_date_executor_key";--> statement-breakpoint
ALTER TABLE "brain_jobs" DROP CONSTRAINT "brain_jobs_executor_check";--> statement-breakpoint
ALTER TABLE "brain_jobs" DROP CONSTRAINT "brain_jobs_status_check";--> statement-breakpoint
ALTER TABLE "brain_pages" DROP CONSTRAINT "brain_pages_check";--> statement-breakpoint
DROP INDEX "brain_pages_embedding_idx";--> statement-breakpoint
ALTER TABLE "brain_jobs" DROP COLUMN "lease_id";--> statement-breakpoint
ALTER TABLE "brain_jobs" DROP COLUMN "lease_until";--> statement-breakpoint
ALTER TABLE "brain_jobs" DROP COLUMN "executor";--> statement-breakpoint
ALTER TABLE "brain_pages" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "brain_pages" DROP COLUMN "embedding_model";--> statement-breakpoint
ALTER TABLE "brain_pages" DROP COLUMN "embedding_version";--> statement-breakpoint
ALTER TABLE "brain_pages" DROP COLUMN "embedded_at";--> statement-breakpoint
ALTER TABLE "brain_jobs" ADD CONSTRAINT "brain_jobs_owner_id_kind_run_date_key" UNIQUE("owner_id","kind","run_date");--> statement-breakpoint
ALTER TABLE "brain_jobs" ADD CONSTRAINT "brain_jobs_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'partial'::text, 'failed'::text]));
