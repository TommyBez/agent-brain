/** Internal SQL only: callers choose a known alias and positional query parameters. */
export function pendingEmbeddingsSql(
  alias = "",
  modelParameter = 2,
  chunkerParameter = 3,
) {
  const prefix = alias ? `${alias}.` : "";
  return `(${prefix}chunk_index_version IS DISTINCT FROM ${prefix}version OR ${prefix}chunk_index_model IS DISTINCT FROM $${modelParameter} OR ${prefix}chunk_index_chunker IS DISTINCT FROM $${chunkerParameter})`;
}
