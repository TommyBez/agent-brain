CREATE TABLE "brain_consolidation_queue" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"task_ids" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_consolidation_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"model" text NOT NULL,
	"day" date NOT NULL,
	"reserved_nano" bigint NOT NULL,
	"actual_nano" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "brain_consolidation_spend_day_idx" ON "brain_consolidation_spend" USING btree ("day");