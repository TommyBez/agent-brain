-- PostgreSQL extensions are provisioned before their types and operator classes.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "agent_tokens_name_check" CHECK ((char_length(name) >= 1) AND (char_length(name) <= 80)),
	CONSTRAINT "agent_tokens_token_hash_check" CHECK (char_length(token_hash) = 64),
	CONSTRAINT "agent_tokens_scopes_check" CHECK ((cardinality(scopes) > 0) AND (scopes <@ ARRAY['brain:read'::text, 'brain:write'::text, 'brain:maintain'::text]))
);
--> statement-breakpoint
CREATE TABLE "brain_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"page_id" uuid NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_activity_action_check" CHECK (action = ANY (ARRAY['create'::text, 'write'::text, 'append'::text, 'embed'::text]))
);
--> statement-breakpoint
CREATE TABLE "brain_identities" (
	"owner_id" text NOT NULL,
	"page_id" uuid NOT NULL,
	"type" text NOT NULL,
	"identity_key" text NOT NULL,
	CONSTRAINT "brain_identities_pkey" PRIMARY KEY("owner_id","type","identity_key")
);
--> statement-breakpoint
CREATE TABLE "brain_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"run_date" date DEFAULT CURRENT_DATE NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workflow_run_id" text,
	"executor" text DEFAULT 'workflow' NOT NULL,
	CONSTRAINT "brain_jobs_owner_kind_date_executor_key" UNIQUE("owner_id","kind","run_date","executor"),
	CONSTRAINT "brain_jobs_workflow_run_id_check" CHECK ((workflow_run_id IS NULL) OR ((char_length(workflow_run_id) >= 1) AND (char_length(workflow_run_id) <= 256))),
	CONSTRAINT "brain_jobs_kind_check" CHECK (kind = ANY (ARRAY['consolidation'::text, 'embeddings'::text, 'export'::text])),
	CONSTRAINT "brain_jobs_executor_check" CHECK (executor = ANY (ARRAY['github'::text, 'workflow'::text])),
	CONSTRAINT "brain_jobs_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'partial'::text, 'failed'::text, 'cancelled'::text]))
);
--> statement-breakpoint
CREATE TABLE "brain_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"type" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_links_owner_id_source_id_target_id_type_key" UNIQUE("owner_id","source_id","target_id","type"),
	CONSTRAINT "brain_links_type_check" CHECK (type = ANY (ARRAY['works_at'::text, 'owns'::text, 'part_of'::text, 'relates_to'::text, 'decided_in'::text, 'references'::text, 'depends_on'::text, 'supersedes'::text, 'collaborates_with'::text])),
	CONSTRAINT "brain_links_check" CHECK (source_id <> target_id)
);
--> statement-breakpoint
CREATE TABLE "brain_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_page_chunks" (
	"owner_id" text NOT NULL,
	"page_id" uuid NOT NULL,
	"page_version" integer NOT NULL,
	"embedding_model" text NOT NULL,
	"chunker_version" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_page_chunks_pkey" PRIMARY KEY("owner_id","page_id","page_version","embedding_model","chunker_version","chunk_index"),
	CONSTRAINT "brain_page_chunks_page_version_check" CHECK (page_version > 0),
	CONSTRAINT "brain_page_chunks_chunk_index_check" CHECK (chunk_index >= 0),
	CONSTRAINT "brain_page_chunks_content_hash_check" CHECK (content_hash ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "brain_page_chunks_start_offset_check" CHECK (start_offset >= 0),
	CONSTRAINT "brain_page_chunks_check" CHECK (end_offset >= start_offset),
	CONSTRAINT "brain_page_chunks_token_count_check" CHECK (token_count > 0)
);
--> statement-breakpoint
CREATE TABLE "brain_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"markdown" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"embedding_version" integer,
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_document" "tsvector" GENERATED ALWAYS AS (((setweight(to_tsvector('simple'::regconfig, title), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, summary), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, markdown), 'C'::"char"))) STORED,
	"chunk_index_version" integer,
	"chunk_index_model" text,
	"chunk_index_chunker" text,
	"chunk_indexed_at" timestamp with time zone,
	CONSTRAINT "brain_pages_owner_id_slug_key" UNIQUE("owner_id","slug"),
	CONSTRAINT "brain_pages_owner_id_id_key" UNIQUE("owner_id","id"),
	CONSTRAINT "brain_pages_owner_id_id_type_key" UNIQUE("owner_id","id","type"),
	CONSTRAINT "brain_pages_slug_check" CHECK ((char_length(slug) >= 1) AND (char_length(slug) <= 200)),
	CONSTRAINT "brain_pages_type_check" CHECK (type = ANY (ARRAY['person'::text, 'client'::text, 'project'::text, 'article'::text, 'decision'::text, 'note'::text])),
	CONSTRAINT "brain_pages_title_check" CHECK ((char_length(title) >= 1) AND (char_length(title) <= 200)),
	CONSTRAINT "brain_pages_markdown_check" CHECK ((char_length(markdown) >= 1) AND (char_length(markdown) <= 200000)),
	CONSTRAINT "brain_pages_version_check" CHECK (version > 0),
	CONSTRAINT "brain_pages_check" CHECK (((embedding IS NULL) AND (embedding_model IS NULL) AND (embedding_version IS NULL) AND (embedded_at IS NULL)) OR ((embedding IS NOT NULL) AND (embedding_model IS NOT NULL) AND (embedding_version = version) AND (embedded_at IS NOT NULL))),
	CONSTRAINT "brain_pages_chunk_index_state" CHECK (((chunk_index_version IS NULL) AND (chunk_index_model IS NULL) AND (chunk_index_chunker IS NULL) AND (chunk_indexed_at IS NULL)) OR ((chunk_index_version > 0) AND (chunk_index_version <= version) AND (chunk_index_model IS NOT NULL) AND (chunk_index_chunker IS NOT NULL) AND (chunk_indexed_at IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "brain_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_key" text,
	CONSTRAINT "brain_revisions_owner_id_page_id_version_key" UNIQUE("owner_id","page_id","version"),
	CONSTRAINT "brain_revisions_operation_key_check" CHECK ((operation_key IS NULL) OR ((char_length(operation_key) >= 1) AND (char_length(operation_key) <= 256)))
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"publicKey" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauthAccessToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"refreshId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauthAccessToken_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauthClient" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"clientSecret" text,
	"clientDiscoveryId" text,
	"disabled" boolean,
	"skipConsent" boolean,
	"enableEndSession" boolean,
	"subjectType" text,
	"scopes" jsonb,
	"clientCredentialsScopes" jsonb,
	"userId" text,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" jsonb,
	"tos" text,
	"policy" text,
	"softwareId" text,
	"softwareVersion" text,
	"softwareStatement" text,
	"redirectUris" jsonb NOT NULL,
	"postLogoutRedirectUris" jsonb,
	"backchannelLogoutUri" text,
	"backchannelLogoutSessionRequired" boolean,
	"tokenEndpointAuthMethod" text,
	"applicationType" text,
	"jwks" text,
	"jwksUri" text,
	"grantTypes" jsonb,
	"responseTypes" jsonb,
	"requirePKCE" boolean,
	"dpopBoundAccessTokens" boolean,
	"referenceId" text,
	"metadata" jsonb,
	CONSTRAINT "oauthClient_clientId_key" UNIQUE("clientId")
);
--> statement-breakpoint
CREATE TABLE "oauthClientAssertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauthClientResource" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"resourceId" text NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauthConsent" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"userId" text,
	"referenceId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"scopes" jsonb NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauthRefreshToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text NOT NULL,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"rotatedAt" timestamp with time zone,
	"rotationReplayResponse" text,
	"rotationReplayExpiresAt" timestamp with time zone,
	"authTime" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauthRefreshToken_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauthResource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"accessTokenTtl" integer,
	"refreshTokenTtl" integer,
	"signingAlgorithm" text,
	"signingKeyId" text,
	"allowedScopes" jsonb,
	"customClaims" jsonb,
	"dpopBoundAccessTokensRequired" boolean,
	"disabled" boolean,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"policyVersion" integer,
	"metadata" jsonb,
	CONSTRAINT "oauthResource_identifier_key" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "rateLimit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"lastRequest" bigint NOT NULL,
	CONSTRAINT "rateLimit_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_activity" ADD CONSTRAINT "brain_activity_owner_id_page_id_fkey" FOREIGN KEY ("owner_id","page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_identities" ADD CONSTRAINT "brain_identities_owner_id_page_id_type_fkey" FOREIGN KEY ("owner_id","page_id","type") REFERENCES "public"."brain_pages"("owner_id","id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_links" ADD CONSTRAINT "brain_links_owner_id_source_id_fkey" FOREIGN KEY ("owner_id","source_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_links" ADD CONSTRAINT "brain_links_owner_id_target_id_fkey" FOREIGN KEY ("owner_id","target_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_page_chunks" ADD CONSTRAINT "brain_page_chunks_owner_id_page_id_fkey" FOREIGN KEY ("owner_id","page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_revisions" ADD CONSTRAINT "brain_revisions_owner_id_page_id_fkey" FOREIGN KEY ("owner_id","page_id") REFERENCES "public"."brain_pages"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "public"."oauthRefreshToken"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthClient" ADD CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthClientResource" ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthClientResource" ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "public"."oauthResource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthConsent" ADD CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthConsent" ADD CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "agent_tokens_owner_idx" ON "agent_tokens" USING btree ("owner_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "brain_activity_owner_created_idx" ON "brain_activity" USING btree ("owner_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "brain_identities_page_idx" ON "brain_identities" USING btree ("owner_id","page_id");--> statement-breakpoint
CREATE INDEX "brain_identities_trgm_idx" ON "brain_identities" USING gin ("identity_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "brain_jobs_pending_idx" ON "brain_jobs" USING btree ("owner_id","status","created_at");--> statement-breakpoint
CREATE INDEX "brain_links_target_idx" ON "brain_links" USING btree ("owner_id","target_id");--> statement-breakpoint
CREATE INDEX "brain_page_chunks_embedding_idx" ON "brain_page_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "brain_page_chunks_reuse_idx" ON "brain_page_chunks" USING btree ("owner_id","page_id","embedding_model","content_hash");--> statement-breakpoint
CREATE INDEX "brain_pages_embedding_idx" ON "brain_pages" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "brain_pages_owner_type_idx" ON "brain_pages" USING btree ("owner_id","type");--> statement-breakpoint
CREATE INDEX "brain_pages_owner_updated_idx" ON "brain_pages" USING btree ("owner_id","updated_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "brain_pages_search_idx" ON "brain_pages" USING gin ("search_document" tsvector_ops);--> statement-breakpoint
CREATE INDEX "brain_pages_title_trgm_idx" ON "brain_pages" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "brain_revisions_operation_key_idx" ON "brain_revisions" USING btree ("owner_id","operation_key") WHERE (operation_key IS NOT NULL);--> statement-breakpoint
CREATE INDEX "brain_revisions_owner_created_idx" ON "brain_revisions" USING btree ("owner_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" USING btree ("authorizationCodeId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" USING btree ("refreshId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource" USING btree ("clientId");--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauthClientResource" USING btree ("clientId","resourceId");--> statement-breakpoint
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource" USING btree ("resourceId");--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" USING btree ("authorizationCodeId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");