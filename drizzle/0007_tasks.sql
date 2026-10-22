-- Generated columns and CHECK constraints accept only IMMUTABLE expressions.
-- array_to_string is STABLE, so it is wrapped once here; the wrappers only see
-- text, never locale- or setting-dependent output.
CREATE FUNCTION "public"."brain_text_elements_within"(items text[], max_length integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$SELECT coalesce(bool_and(item IS NOT NULL AND char_length(item) BETWEEN 1 AND max_length), true) FROM unnest(items) AS item$$;--> statement-breakpoint
CREATE FUNCTION "public"."brain_task_search_document"(title text, acceptance_criteria text[], description text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$SELECT setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce(array_to_string(acceptance_criteria, ' '), '')), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce(description, '')), 'C')$$;--> statement-breakpoint
CREATE TABLE "brain_agent_clients" (
	"owner_id" text NOT NULL,
	"client_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_agent_clients_pkey" PRIMARY KEY("owner_id","client_id"),
	CONSTRAINT "brain_agent_clients_client_id_check" CHECK (char_length(client_id) BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE "brain_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"system_key" text,
	"label" text NOT NULL,
	"label_verified" boolean DEFAULT false NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"create_policy" text DEFAULT 'triage' NOT NULL,
	"trusted_creator" boolean DEFAULT false NOT NULL,
	"claim_on_request" boolean,
	"disabled_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_agents_owner_id_id_key" UNIQUE("owner_id","id"),
	CONSTRAINT "brain_agents_kind_check" CHECK (kind = ANY (ARRAY['owner'::text, 'agent'::text, 'system'::text])),
	CONSTRAINT "brain_agents_system_key_check" CHECK (system_key = ANY (ARRAY['consolidator'::text, 'task_keeper'::text]) AND ((kind = 'system'::text) = (system_key IS NOT NULL))),
	CONSTRAINT "brain_agents_label_check" CHECK (char_length(label) BETWEEN 1 AND 80),
	CONSTRAINT "brain_agents_capabilities_check" CHECK ((cardinality(capabilities) <= 50) AND brain_text_elements_within(capabilities, 100)),
	CONSTRAINT "brain_agents_create_policy_check" CHECK (create_policy = ANY (ARRAY['triage'::text, 'direct'::text])),
	CONSTRAINT "brain_agents_owner_state_check" CHECK ((kind <> 'owner'::text) OR (disabled_at IS NULL)),
	CONSTRAINT "brain_agents_trusted_creator_check" CHECK ((kind = 'agent'::text) OR (NOT trusted_creator))
);
--> statement-breakpoint
CREATE TABLE "brain_task_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "brain_task_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" text NOT NULL,
	"task_id" uuid,
	"actor_agent_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"note" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_task_events_action_check" CHECK (action = ANY (ARRAY['created'::text, 'edited'::text, 'approved'::text, 'delegated'::text, 'status_changed'::text, 'claimed'::text, 'reported'::text, 'asked'::text, 'answered'::text, 'released'::text, 'completed'::text, 'reviewed'::text, 'links_changed'::text, 'note'::text, 'purged'::text]) AND ((task_id IS NULL) = (action = 'purged'::text))),
	CONSTRAINT "brain_task_events_status_check" CHECK (from_status = ANY (ARRAY['triage'::text, 'ready'::text, 'in_progress'::text, 'needs_input'::text, 'blocked'::text, 'in_review'::text, 'on_hold'::text, 'done'::text, 'canceled'::text]) AND to_status = ANY (ARRAY['triage'::text, 'ready'::text, 'in_progress'::text, 'needs_input'::text, 'blocked'::text, 'in_review'::text, 'on_hold'::text, 'done'::text, 'canceled'::text])),
	CONSTRAINT "brain_task_events_note_check" CHECK ((note IS NULL) OR (char_length(note) BETWEEN 1 AND 4000)),
	CONSTRAINT "brain_task_events_payload_check" CHECK (jsonb_typeof(payload) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "brain_task_links" (
	"owner_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"role" text NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"confidence" real,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid NOT NULL,
	"decided_by_agent_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_task_links_pkey" PRIMARY KEY("owner_id","task_id","page_id","role"),
	CONSTRAINT "brain_task_links_role_check" CHECK (role = ANY (ARRAY['context'::text, 'decision'::text, 'stakeholder'::text, 'source'::text, 'produced'::text])),
	CONSTRAINT "brain_task_links_origin_check" CHECK (origin = ANY (ARRAY['owner'::text, 'agent'::text, 'rule'::text, 'provenance'::text, 'consolidator'::text, 'task_keeper'::text])),
	CONSTRAINT "brain_task_links_status_check" CHECK (status = ANY (ARRAY['suggested'::text, 'active'::text, 'rejected'::text, 'retracted'::text])),
	CONSTRAINT "brain_task_links_confidence_check" CHECK ((confidence IS NULL) OR (confidence BETWEEN 0 AND 1)),
	CONSTRAINT "brain_task_links_evidence_check" CHECK (jsonb_typeof(evidence) = 'object'::text),
	CONSTRAINT "brain_task_links_decision_check" CHECK ((decided_at IS NULL) = (decided_by_agent_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "brain_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"acceptance_criteria" text[] DEFAULT '{}'::text[] NOT NULL,
	"expected_output" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'triage' NOT NULL,
	"blocked_reason" text,
	"status_note" text,
	"priority" smallint DEFAULT 2 NOT NULL,
	"due_kind" text DEFAULT 'unset' NOT NULL,
	"due_on" date,
	"due_at" timestamp with time zone,
	"due_text" text,
	"requires_human" boolean DEFAULT false NOT NULL,
	"review_policy" text DEFAULT 'auto' NOT NULL,
	"delegate_agent_id" uuid,
	"required_capability" text,
	"project_page_id" uuid,
	"parent_task_id" uuid,
	"origin" text NOT NULL,
	"owner_quote" text,
	"created_by_agent_id" uuid NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_agent_id" uuid,
	"claimed_by_agent_id" uuid,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"input_requested_at" timestamp with time zone,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"completion" jsonb,
	"completed_lease_hash" text,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text,
	"idempotency_fingerprint" text,
	"search_document" "tsvector" GENERATED ALWAYS AS (brain_task_search_document(title, acceptance_criteria, description)) STORED,
	"semantic_fingerprint" text,
	"embedding" vector(1536),
	"embedding_model" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_tasks_owner_id_id_key" UNIQUE("owner_id","id"),
	CONSTRAINT "brain_tasks_owner_id_number_key" UNIQUE("owner_id","number"),
	CONSTRAINT "brain_tasks_number_check" CHECK (number > 0),
	CONSTRAINT "brain_tasks_title_check" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "brain_tasks_description_check" CHECK (char_length(description) <= 20000),
	CONSTRAINT "brain_tasks_acceptance_criteria_check" CHECK ((cardinality(acceptance_criteria) <= 20) AND brain_text_elements_within(acceptance_criteria, 500)),
	CONSTRAINT "brain_tasks_expected_output_check" CHECK (expected_output = ANY (ARRAY['none'::text, 'decision'::text, 'page'::text, 'artifact'::text, 'external_action'::text])),
	CONSTRAINT "brain_tasks_status_check" CHECK (status = ANY (ARRAY['triage'::text, 'ready'::text, 'in_progress'::text, 'needs_input'::text, 'blocked'::text, 'in_review'::text, 'on_hold'::text, 'done'::text, 'canceled'::text])),
	CONSTRAINT "brain_tasks_blocked_reason_check" CHECK (blocked_reason = ANY (ARRAY['dependency'::text, 'external'::text, 'human_step'::text, 'decision'::text]) AND ((status = 'blocked'::text) = (blocked_reason IS NOT NULL))),
	CONSTRAINT "brain_tasks_status_note_check" CHECK ((status_note IS NULL) OR (char_length(status_note) BETWEEN 1 AND 2000)),
	CONSTRAINT "brain_tasks_priority_check" CHECK (priority BETWEEN 0 AND 3),
	CONSTRAINT "brain_tasks_due_kind_check" CHECK (due_kind = ANY (ARRAY['unset'::text, 'date'::text, 'datetime'::text, 'approximate'::text, 'event'::text, 'hard'::text])),
	CONSTRAINT "brain_tasks_due_text_check" CHECK ((due_text IS NULL) OR (char_length(due_text) BETWEEN 1 AND 200)),
	CONSTRAINT "brain_tasks_due_unset_check" CHECK ((due_kind <> 'unset'::text) OR ((due_on IS NULL) AND (due_at IS NULL))),
	CONSTRAINT "brain_tasks_due_date_check" CHECK ((due_kind <> 'date'::text) OR ((due_on IS NOT NULL) AND (due_at IS NULL))),
	CONSTRAINT "brain_tasks_due_datetime_check" CHECK ((due_kind <> 'datetime'::text) OR ((due_at IS NOT NULL) AND (due_on IS NULL))),
	CONSTRAINT "brain_tasks_due_approximate_check" CHECK ((due_kind <> 'approximate'::text) OR ((due_text IS NOT NULL) AND (due_at IS NULL))),
	CONSTRAINT "brain_tasks_due_event_check" CHECK ((due_kind <> 'event'::text) OR ((due_text IS NOT NULL) AND (due_at IS NULL))),
	CONSTRAINT "brain_tasks_due_hard_check" CHECK ((due_kind <> 'hard'::text) OR (num_nonnulls(due_on, due_at) = 1)),
	CONSTRAINT "brain_tasks_review_policy_check" CHECK (review_policy = ANY (ARRAY['auto'::text, 'owner'::text]) AND ((expected_output <> ALL (ARRAY['decision'::text, 'external_action'::text])) OR (review_policy = 'owner'::text))),
	CONSTRAINT "brain_tasks_required_capability_check" CHECK ((required_capability IS NULL) OR (char_length(required_capability) BETWEEN 1 AND 100)),
	CONSTRAINT "brain_tasks_parent_task_id_check" CHECK (parent_task_id IS NULL OR parent_task_id <> id),
	CONSTRAINT "brain_tasks_origin_check" CHECK (origin = ANY (ARRAY['owner_ui'::text, 'owner_request'::text, 'owner_plan'::text, 'subtask'::text, 'handoff'::text, 'extracted'::text, 'recurrence'::text])),
	CONSTRAINT "brain_tasks_owner_quote_check" CHECK ((owner_quote IS NULL) OR (char_length(owner_quote) BETWEEN 1 AND 500)),
	CONSTRAINT "brain_tasks_approval_check" CHECK ((approved_at IS NULL) = (approved_by_agent_id IS NULL)),
	CONSTRAINT "brain_tasks_claim_check" CHECK ((claimed_by_agent_id IS NULL) = (lease_id IS NULL)),
	CONSTRAINT "brain_tasks_lease_check" CHECK (((lease_id IS NULL) AND (lease_expires_at IS NULL) AND (status <> 'needs_input'::text)) OR ((lease_id IS NOT NULL) AND (claimed_at IS NOT NULL) AND (((status = 'in_progress'::text) AND (lease_expires_at IS NOT NULL)) OR ((status = 'needs_input'::text) AND (lease_expires_at IS NULL) AND (input_requested_at IS NOT NULL))))),
	CONSTRAINT "brain_tasks_claim_count_check" CHECK (claim_count >= 0),
	CONSTRAINT "brain_tasks_completion_check" CHECK ((completion IS NULL) OR (jsonb_typeof(completion) = 'object'::text)),
	CONSTRAINT "brain_tasks_completed_lease_hash_check" CHECK ((completed_lease_hash IS NULL) OR (completed_lease_hash ~ '^[a-f0-9]{64}$'::text)),
	CONSTRAINT "brain_tasks_version_check" CHECK (version > 0),
	CONSTRAINT "brain_tasks_idempotency_check" CHECK (((idempotency_key IS NULL) = (idempotency_fingerprint IS NULL)) AND ((idempotency_key IS NULL) OR (char_length(idempotency_key) BETWEEN 8 AND 100)) AND ((idempotency_fingerprint IS NULL) OR (idempotency_fingerprint ~ '^[a-f0-9]{64}$'::text))),
	CONSTRAINT "brain_tasks_embedding_check" CHECK (((embedding IS NULL) = (embedding_model IS NULL)) AND ((embedding IS NULL) OR (semantic_fingerprint IS NOT NULL)) AND ((semantic_fingerprint IS NULL) OR (semantic_fingerprint ~ '^[a-f0-9]{64}$'::text)) AND ((embedding_model IS NULL) OR (char_length(embedding_model) BETWEEN 1 AND 200)))
);
--> statement-breakpoint
ALTER TABLE "brain_jobs" DROP CONSTRAINT "brain_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "brain_activity" ADD COLUMN "actor_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "brain_revisions" ADD COLUMN "actor_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "brain_agent_clients" ADD CONSTRAINT "brain_agent_clients_owner_id_agent_id_fkey" FOREIGN KEY ("owner_id","agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_events" ADD CONSTRAINT "brain_task_events_owner_id_task_id_fkey" FOREIGN KEY ("owner_id","task_id") REFERENCES "public"."brain_tasks"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_events" ADD CONSTRAINT "brain_task_events_owner_id_actor_agent_id_fkey" FOREIGN KEY ("owner_id","actor_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_links" ADD CONSTRAINT "brain_task_links_owner_id_task_id_fkey" FOREIGN KEY ("owner_id","task_id") REFERENCES "public"."brain_tasks"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_links" ADD CONSTRAINT "brain_task_links_owner_id_page_id_fkey" FOREIGN KEY ("owner_id","page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_links" ADD CONSTRAINT "brain_task_links_owner_id_created_by_agent_id_fkey" FOREIGN KEY ("owner_id","created_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_links" ADD CONSTRAINT "brain_task_links_owner_id_decided_by_agent_id_fkey" FOREIGN KEY ("owner_id","decided_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_owner_id_created_by_agent_id_fkey" FOREIGN KEY ("owner_id","created_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_owner_id_approved_by_agent_id_fkey" FOREIGN KEY ("owner_id","approved_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_owner_id_delegate_agent_id_fkey" FOREIGN KEY ("owner_id","delegate_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_owner_id_claimed_by_agent_id_fkey" FOREIGN KEY ("owner_id","claimed_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- owner_id is NOT NULL, so composite SET NULL clears only the referencing column (PostgreSQL 15+).
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_owner_id_project_page_id_fkey" FOREIGN KEY ("owner_id","project_page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE SET NULL ("project_page_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_owner_id_parent_task_id_fkey" FOREIGN KEY ("owner_id","parent_task_id") REFERENCES "public"."brain_tasks"("owner_id","id") ON DELETE SET NULL ("parent_task_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_agent_clients_agent_idx" ON "brain_agent_clients" USING btree ("owner_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brain_agents_owner_kind_idx" ON "brain_agents" USING btree ("owner_id") WHERE kind = 'owner'::text;--> statement-breakpoint
CREATE UNIQUE INDEX "brain_agents_system_key_idx" ON "brain_agents" USING btree ("owner_id","system_key") WHERE system_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "brain_task_events_task_idx" ON "brain_task_events" USING btree ("owner_id","task_id","id");--> statement-breakpoint
CREATE INDEX "brain_task_events_owner_idx" ON "brain_task_events" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "brain_task_links_page_idx" ON "brain_task_links" USING btree ("owner_id","page_id","status");--> statement-breakpoint
CREATE INDEX "brain_tasks_owner_status_idx" ON "brain_tasks" USING btree ("owner_id","status","priority","created_at");--> statement-breakpoint
CREATE INDEX "brain_tasks_project_idx" ON "brain_tasks" USING btree ("owner_id","project_page_id","status");--> statement-breakpoint
CREATE INDEX "brain_tasks_lease_idx" ON "brain_tasks" USING btree ("owner_id","lease_expires_at") WHERE lease_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "brain_tasks_claimed_by_idx" ON "brain_tasks" USING btree ("owner_id","claimed_by_agent_id") WHERE claimed_by_agent_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "brain_tasks_parent_idx" ON "brain_tasks" USING btree ("owner_id","parent_task_id") WHERE parent_task_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "brain_tasks_search_idx" ON "brain_tasks" USING gin ("search_document" tsvector_ops);--> statement-breakpoint
CREATE INDEX "brain_tasks_title_trgm_idx" ON "brain_tasks" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "brain_tasks_idempotency_idx" ON "brain_tasks" USING btree ("owner_id","created_by_agent_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_owner_id_agent_id_fkey" FOREIGN KEY ("owner_id","agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_activity" ADD CONSTRAINT "brain_activity_owner_id_actor_agent_id_fkey" FOREIGN KEY ("owner_id","actor_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_revisions" ADD CONSTRAINT "brain_revisions_owner_id_actor_agent_id_fkey" FOREIGN KEY ("owner_id","actor_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_jobs" ADD CONSTRAINT "brain_jobs_kind_check" CHECK (kind = ANY (ARRAY['consolidation'::text, 'embeddings'::text, 'export'::text, 'task_keeper'::text, 'task_links'::text]));