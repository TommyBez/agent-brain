ALTER TABLE "brain_pages" DROP CONSTRAINT "brain_pages_type_check";--> statement-breakpoint
ALTER TABLE "brain_pages" ADD COLUMN "relationships" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Clients become companies holding the client relationship. Identity rows key
-- on the page type through a composite foreign key without ON UPDATE, so the
-- key is released while both sides move together.
ALTER TABLE "brain_identities" DROP CONSTRAINT "brain_identities_owner_id_page_id_type_fkey";--> statement-breakpoint
UPDATE "brain_pages" SET "type" = 'company', "relationships" = ARRAY['client'::text], "slug" = regexp_replace("slug", '^client/', 'company/') WHERE "type" = 'client';--> statement-breakpoint
UPDATE "brain_identities" SET "type" = 'company' WHERE "type" = 'client';--> statement-breakpoint
UPDATE "brain_revisions" SET "snapshot" = jsonb_set(jsonb_set("snapshot", '{type}', '"company"'::jsonb), '{slug}', to_jsonb(regexp_replace("snapshot"->>'slug', '^client/', 'company/'))) || '{"relationships":["client"]}'::jsonb WHERE "snapshot"->>'type' = 'client';--> statement-breakpoint
UPDATE "brain_revisions" SET "snapshot" = "snapshot" || '{"relationships":[]}'::jsonb WHERE NOT "snapshot" ? 'relationships';--> statement-breakpoint
ALTER TABLE "brain_identities" ADD CONSTRAINT "brain_identities_owner_id_page_id_type_fkey" FOREIGN KEY ("owner_id","page_id","type") REFERENCES "public"."brain_pages"("owner_id","id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_pages" ADD CONSTRAINT "brain_pages_relationships_check" CHECK (relationships <@ ARRAY['client'::text, 'prospect'::text, 'former_employer'::text] AND (type = 'company'::text OR cardinality(relationships) = 0));--> statement-breakpoint
ALTER TABLE "brain_pages" ADD CONSTRAINT "brain_pages_type_check" CHECK (type = ANY (ARRAY['person'::text, 'company'::text, 'project'::text, 'article'::text, 'decision'::text, 'note'::text]));
