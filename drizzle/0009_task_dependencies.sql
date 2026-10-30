CREATE TABLE "brain_task_dependencies" (
	"owner_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"created_by_agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_task_dependencies_pkey" PRIMARY KEY("owner_id","task_id","depends_on_task_id"),
	CONSTRAINT "brain_task_dependencies_check" CHECK (task_id <> depends_on_task_id)
);
--> statement-breakpoint
CREATE TABLE "brain_task_recurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"template" jsonb NOT NULL,
	"rrule" text NOT NULL,
	"next_at" timestamp with time zone,
	"project_page_id" uuid,
	"paused_at" timestamp with time zone,
	"created_by_agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_task_recurrences_owner_id_id_key" UNIQUE("owner_id","id"),
	CONSTRAINT "brain_task_recurrences_kind_check" CHECK (kind = ANY (ARRAY['task'::text, 'meeting'::text])),
	CONSTRAINT "brain_task_recurrences_template_check" CHECK (jsonb_typeof(template) = 'object'::text),
	CONSTRAINT "brain_task_recurrences_rrule_check" CHECK (char_length(rrule) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
-- The table is created empty by 0007, so the volatile default rewrites nothing.
ALTER TABLE "brain_task_events" ADD COLUMN "tx" "xid8" DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD COLUMN "recurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD COLUMN "occurrence_on" date;--> statement-breakpoint
ALTER TABLE "brain_task_dependencies" ADD CONSTRAINT "brain_task_dependencies_owner_id_task_id_fkey" FOREIGN KEY ("owner_id","task_id") REFERENCES "public"."brain_tasks"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_dependencies" ADD CONSTRAINT "brain_task_dependencies_owner_id_depends_on_task_id_fkey" FOREIGN KEY ("owner_id","depends_on_task_id") REFERENCES "public"."brain_tasks"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_dependencies" ADD CONSTRAINT "brain_task_dependencies_owner_id_created_by_agent_id_fkey" FOREIGN KEY ("owner_id","created_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- owner_id is NOT NULL, so composite SET NULL clears only the referencing column.
ALTER TABLE "brain_task_recurrences" ADD CONSTRAINT "brain_task_recurrences_owner_id_project_page_id_fkey" FOREIGN KEY ("owner_id","project_page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE SET NULL ("project_page_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_task_recurrences" ADD CONSTRAINT "brain_task_recurrences_owner_id_created_by_agent_id_fkey" FOREIGN KEY ("owner_id","created_by_agent_id") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_task_dependencies_depends_on_idx" ON "brain_task_dependencies" USING btree ("owner_id","depends_on_task_id");--> statement-breakpoint
CREATE INDEX "brain_task_recurrences_due_idx" ON "brain_task_recurrences" USING btree ("owner_id","next_at") WHERE paused_at IS NULL;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_owner_id_recurrence_id_fkey" FOREIGN KEY ("owner_id","recurrence_id") REFERENCES "public"."brain_task_recurrences"("owner_id","id") ON DELETE SET NULL ("recurrence_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_recurrence_occurrence_key" UNIQUE("owner_id","recurrence_id","occurrence_on");--> statement-breakpoint
ALTER TABLE "brain_tasks" ADD CONSTRAINT "brain_tasks_recurrence_check" CHECK ((recurrence_id IS NULL) OR (occurrence_on IS NOT NULL));