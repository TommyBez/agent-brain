-- A completed manifest is published only after every section has its vector.
-- Older rows remain reusable while a new revision is being indexed, but the
-- page's completion marker excludes those rows from retrieval after a write.
ALTER TABLE brain_pages
  ADD COLUMN chunk_index_version integer,
  ADD COLUMN chunk_index_model text,
  ADD COLUMN chunk_index_chunker text,
  ADD COLUMN chunk_indexed_at timestamptz,
  ADD CONSTRAINT brain_pages_chunk_index_state CHECK (
    (chunk_index_version IS NULL AND chunk_index_model IS NULL AND chunk_index_chunker IS NULL AND chunk_indexed_at IS NULL)
    OR (chunk_index_version > 0 AND chunk_index_version <= version AND chunk_index_model IS NOT NULL AND chunk_index_chunker IS NOT NULL AND chunk_indexed_at IS NOT NULL)
  );

CREATE TABLE brain_page_chunks (
  owner_id text NOT NULL,
  page_id uuid NOT NULL,
  page_version integer NOT NULL CHECK (page_version > 0),
  embedding_model text NOT NULL,
  chunker_version text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  content text NOT NULL,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset >= start_offset),
  token_count integer NOT NULL CHECK (token_count > 0),
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, page_id, page_version, embedding_model, chunker_version, chunk_index),
  FOREIGN KEY (owner_id, page_id) REFERENCES brain_pages (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX brain_page_chunks_reuse_idx ON brain_page_chunks (owner_id, page_id, embedding_model, content_hash);
CREATE INDEX brain_page_chunks_embedding_idx ON brain_page_chunks USING hnsw (embedding vector_cosine_ops);
