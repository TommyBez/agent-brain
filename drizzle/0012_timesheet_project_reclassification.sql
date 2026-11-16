ALTER TABLE "brain_time_entries" DROP CONSTRAINT "brain_time_entries_project_type_check";--> statement-breakpoint
ALTER TABLE "brain_time_entries" DROP CONSTRAINT "brain_time_entries_project_fk";
--> statement-breakpoint
ALTER TABLE "brain_time_entries" ADD CONSTRAINT "brain_time_entries_project_fk" FOREIGN KEY ("owner_id","project_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_time_entries" DROP COLUMN "project_type";