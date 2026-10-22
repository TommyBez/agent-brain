CREATE TABLE "brain_task_extraction_rejections" (
	"owner_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"source_page_id" uuid,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_task_extraction_rejections_pkey" PRIMARY KEY("owner_id","fingerprint"),
	CONSTRAINT "brain_task_extraction_rejections_fingerprint_check" CHECK (fingerprint ~ '^[a-f0-9]{64}$'::text)
);
--> statement-breakpoint
CREATE TABLE "brain_task_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"agent_id" uuid,
	"person_page_id" uuid,
	"group_label" text,
	"source_note" text,
	"created_by_agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_task_parties_member_key" UNIQUE NULLS NOT DISTINCT("owner_id","task_id","role","agent_id","person_page_id","group_label"),
	CONSTRAINT "brain_task_parties_role_check" CHECK (role = ANY (ARRAY['lead'::text, 'support'::text, 'reviewer'::text, 'requester'::text])),
	CONSTRAINT "brain_task_parties_kind_check" CHECK (kind = ANY (ARRAY['owner'::text, 'agent'::text, 'person'::text, 'group'::text])),
	CONSTRAINT "brain_task_parties_member_check" CHECK ((num_nonnulls(agent_id, person_page_id, group_label) = 1) AND ((kind = ANY (ARRAY['owner'::text, 'agent'::text])) = (agent_id IS NOT NULL)) AND ((kind = 'person'::text) = (person_page_id IS NOT NULL)) AND ((kind = 'group'::text) = (group_label IS NOT NULL))),
	CONSTRAINT "brain_task_parties_group_label_check" CHECK ((group_label IS NULL) OR (char_length(group_label) BETWEEN 1 AND 120)),
	CONSTRAINT "brain_task_parties_source_note_check" CHECK ((source_note IS NULL) OR (char_length(source_note) BETWEEN 1 AND 300))
);
--> statement-breakpoint
CREATE TABLE "brain_task_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"keeper_excluded_page_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"paused_project_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"saved_views" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_task_settings_saved_views_check" CHECK (jsonb_typeof(saved_views) = 'array'::text)
);
--> statement-breakpoint
CREATE TABLE "brain_task_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"related_task_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"policy_version" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid NOT NULL,
	"decided_by_agent_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_task_suggestions_owner_id_id_key" UNIQUE("owner_id","id"),
	CONSTRAINT "brain_task_suggestions_owner_id_dedupe_key_key" UNIQUE("owner_id","dedupe_key"),
	CONSTRAINT "brain_task_suggestions_kind_check" CHECK (kind = ANY (ARRAY['overdue_no_outcome'::text, 'stale_claim'::text, 'triage_aging'::text, 'decision_superseded'::text, 'new_source'::text, 'may_be_done'::text, 'criterion_evidence'::text, 'divergent_state'::text, 'duplicate'::text])),
	CONSTRAINT "brain_task_suggestions_status_check" CHECK (status = ANY (ARRAY['open'::text, 'accepted'::text, 'dismissed'::text, 'expired'::text])),
	CONSTRAINT "brain_task_suggestions_related_task_id_check" CHECK ((related_task_id IS NULL) OR (related_task_id <> task_id)),
	CONSTRAINT "brain_task_suggestions_confidence_check" CHECK ((confidence IS NULL) OR (confidence BETWEEN 0 AND 1)),
	CONSTRAINT "brain_task_suggestions_json_check" CHECK ((jsonb_typeof(citations) = 'array'::text) AND (jsonb_typeof(payload) = 'object'::text)),
	CONSTRAINT "brain_task_suggestions_policy_version_check" CHECK (char_length(policy_version) BETWEEN 1 AND 100),
	CONSTRAINT "brain_task_suggestions_dedupe_key_check" CHECK (char_length(dedupe_key) BETWEEN 1 AND 256),
	CONSTRAINT "brain_task_suggestions_decision_check" CHECK ((decided_at IS NULL) = (decided_by_agent_id IS NULL))
);
--> statement-breakpoint
-- Existing spend and the previous deployment (which omits the column) count as pages.
ALTER TABLE "brain_consolidation_spend" ADD COLUMN "purpose" text DEFAULT 'pages' NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_agents" ADD COLUMN "person_page_id" uuid;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD COLUMN "extraction_fingerprint" text;--> statement-breakpoint
-- owner_id is NOT NULL, so composite SET NULL clears only the referencing column.
ALTER TABLE "brain_task_extraction_rejections" ADD CONSTRAINT "brain_task_extraction_rejections_owner_id_source_page_id_fkey" FOREIGN KEY ("owner_id","source_page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE SET NULL ("source_page_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_parties" ADD CONSTRAINT "brain_task_parties_owner_id_task_id_fkey" FOREIGN KEY ("owner_id","task_id") REFERENCES "public"."brain_tasks"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_parties" ADD CONSTRAINT "brain_task_parties_owner_id_agent_id_fkey" FOREIGN KEY ("owner_id","agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_parties" ADD CONSTRAINT "brain_task_parties_owner_id_person_page_id_fkey" FOREIGN KEY ("owner_id","person_page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_parties" ADD CONSTRAINT "brain_task_parties_owner_id_created_by_agent_id_fkey" FOREIGN KEY ("owner_id","created_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_suggestions" ADD CONSTRAINT "brain_task_suggestions_owner_id_task_id_fkey" FOREIGN KEY ("owner_id","task_id") REFERENCES "public"."brain_tasks"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_suggestions" ADD CONSTRAINT "brain_task_suggestions_owner_id_related_task_id_fkey" FOREIGN KEY ("owner_id","related_task_id") REFERENCES "public"."brain_tasks"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_suggestions" ADD CONSTRAINT "brain_task_suggestions_owner_id_created_by_agent_id_fkey" FOREIGN KEY ("owner_id","created_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_suggestions" ADD CONSTRAINT "brain_task_suggestions_owner_id_decided_by_agent_id_fkey" FOREIGN KEY ("owner_id","decided_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_task_parties_task_idx" ON "brain_task_parties" USING btree ("owner_id","task_id","role");--> statement-breakpoint
CREATE INDEX "brain_task_suggestions_task_idx" ON "brain_task_suggestions" USING btree ("owner_id","task_id","status");--> statement-breakpoint
CREATE INDEX "brain_task_suggestions_status_idx" ON "brain_task_suggestions" USING btree ("owner_id","status","created_at");--> statement-breakpoint
ALTER TABLE "brain_agents" ADD CONSTRAINT "brain_agents_owner_id_person_page_id_fkey" FOREIGN KEY ("owner_id","person_page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE SET NULL ("person_page_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_consolidation_spend_day_purpose_idx" ON "brain_consolidation_spend" USING btree ("day","purpose");--> statement-breakpoint
CREATE INDEX "brain_tasks_batch_idx" ON "brain_tasks" USING btree ("owner_id","batch_id") WHERE batch_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "brain_tasks_extraction_fingerprint_idx" ON "brain_tasks" USING btree ("owner_id","extraction_fingerprint") WHERE extraction_fingerprint IS NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_consolidation_spend" ADD CONSTRAINT "brain_consolidation_spend_purpose_check" CHECK (purpose = ANY (ARRAY['pages'::text, 'task_keeper'::text, 'task_links'::text]));--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_extraction_check" CHECK (((batch_id IS NULL) OR (char_length(batch_id) BETWEEN 1 AND 300)) AND ((extraction_fingerprint IS NULL) OR (extraction_fingerprint ~ '^[a-f0-9]{64}$'::text)));