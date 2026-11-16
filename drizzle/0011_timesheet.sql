CREATE TABLE "brain_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"worked_on" date NOT NULL,
	"minutes" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"project_id" uuid,
	"project_type" text DEFAULT 'project' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "brain_time_entries_owner_key" UNIQUE("owner_id","idempotency_key"),
	CONSTRAINT "brain_time_entries_minutes_check" CHECK (minutes BETWEEN 1 AND 1440),
	CONSTRAINT "brain_time_entries_note_check" CHECK (char_length(note) <= 2000),
	CONSTRAINT "brain_time_entries_version_check" CHECK (version > 0),
	CONSTRAINT "brain_time_entries_project_type_check" CHECK (project_type = 'project')
);
--> statement-breakpoint
ALTER TABLE "brain_time_entries" ADD CONSTRAINT "brain_time_entries_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_time_entries" ADD CONSTRAINT "brain_time_entries_project_fk" FOREIGN KEY ("owner_id","project_id","project_type") REFERENCES "public"."brain_pages"("owner_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_time_entries" ADD CONSTRAINT "brain_time_entries_creator_fk" FOREIGN KEY ("owner_id","created_by") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_time_entries" ADD CONSTRAINT "brain_time_entries_editor_fk" FOREIGN KEY ("owner_id","updated_by") REFERENCES "public"."brain_agents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_time_entries_owner_date_idx" ON "brain_time_entries" USING btree ("owner_id","worked_on","id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "brain_time_entries_owner_project_idx" ON "brain_time_entries" USING btree ("owner_id","project_id","worked_on") WHERE deleted_at IS NULL;