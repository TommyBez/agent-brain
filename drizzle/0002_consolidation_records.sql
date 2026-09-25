CREATE TABLE "brain_consolidation_records" (
	"owner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"record_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_consolidation_records_pkey" PRIMARY KEY("owner_id","run_id","kind","record_key"),
	CONSTRAINT "brain_consolidation_records_kind_check" CHECK (kind = ANY (ARRAY['record'::text, 'receipt'::text])),
	CONSTRAINT "brain_consolidation_records_run_id_check" CHECK (char_length(run_id) BETWEEN 1 AND 256),
	CONSTRAINT "brain_consolidation_records_record_key_check" CHECK (char_length(record_key) BETWEEN 1 AND 256)
);
