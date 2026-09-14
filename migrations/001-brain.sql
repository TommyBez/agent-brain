CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE brain_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  slug text NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 200),
  type text NOT NULL CHECK (type IN ('person','client','project','article','decision','note')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary text NOT NULL DEFAULT '',
  markdown text NOT NULL CHECK (char_length(markdown) BETWEEN 1 AND 200000),
  aliases text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  embedding vector(1536),
  embedding_model text,
  embedding_version integer,
  embedded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', summary), 'B') ||
    setweight(to_tsvector('simple', markdown), 'C')
  ) STORED,
  UNIQUE (owner_id, slug),
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, id, type),
  CHECK ((embedding IS NULL AND embedding_model IS NULL AND embedding_version IS NULL AND embedded_at IS NULL)
    OR (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedding_version = version AND embedded_at IS NOT NULL))
);

CREATE INDEX brain_pages_owner_updated_idx ON brain_pages (owner_id, updated_at DESC);
CREATE INDEX brain_pages_owner_type_idx ON brain_pages (owner_id, type);
CREATE INDEX brain_pages_search_idx ON brain_pages USING gin (search_document);
CREATE INDEX brain_pages_embedding_idx ON brain_pages USING hnsw (embedding vector_cosine_ops);
CREATE INDEX brain_pages_title_trgm_idx ON brain_pages USING gin (title gin_trgm_ops);

-- Owns the uniqueness guarantee for canonical names and aliases within an entity type.
-- A write either reserves every normalized identity or rolls back completely.
CREATE TABLE brain_identities (
  owner_id text NOT NULL,
  page_id uuid NOT NULL,
  type text NOT NULL,
  identity_key text NOT NULL,
  PRIMARY KEY (owner_id, type, identity_key),
  FOREIGN KEY (owner_id, page_id, type) REFERENCES brain_pages (owner_id, id, type) ON DELETE CASCADE
);
CREATE INDEX brain_identities_page_idx ON brain_identities (owner_id, page_id);
CREATE INDEX brain_identities_trgm_idx ON brain_identities USING gin (identity_key gin_trgm_ops);

CREATE TABLE brain_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('works_at','owns','part_of','relates_to','decided_in','references','depends_on','supersedes','collaborates_with')),
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, source_id) REFERENCES brain_pages (owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, target_id) REFERENCES brain_pages (owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, source_id, target_id, type),
  CHECK (source_id <> target_id)
);
CREATE INDEX brain_links_target_idx ON brain_links (owner_id, target_id);

CREATE TABLE brain_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  page_id uuid NOT NULL,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, page_id) REFERENCES brain_pages (owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, page_id, version)
);
CREATE INDEX brain_revisions_owner_created_idx ON brain_revisions (owner_id, created_at DESC);

CREATE TABLE brain_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  page_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('create','write','append','embed')),
  version integer NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, page_id) REFERENCES brain_pages (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX brain_activity_owner_created_idx ON brain_activity (owner_id, created_at DESC);
