// Portable worker: the server owns chunk boundaries, hashes and completion.
// Every accepted batch survives an interruption; no page content is truncated.
export async function indexPendingChunks({
  callTool,
  gateway,
  unpack,
  maxPages = 100,
  maxTokens = 120_000,
}) {
  let indexed = 0;
  let embeddedChunks = 0;
  let inputTokens = 0;
  let conflicts = 0;
  for (let batch = 0; batch < 1000 && indexed < maxPages; batch++) {
    const pending = unpack(
      await callTool({
        name: "pending_embeddings",
        arguments: { limit: 1, chunkLimit: 24 },
      }),
    );
    const page = (Array.isArray(pending) ? pending : pending.pages)?.[0];
    if (!page)
      return {
        indexed,
        embeddedChunks,
        inputTokens,
        conflicts,
        budgetReached: false,
      };
    if (
      !Array.isArray(page.chunks) ||
      !page.chunkerVersion ||
      !page.embeddingModel
    )
      throw new Error("The server does not support full-page chunk indexing.");
    const missing = [
      ...new Map(
        page.chunks
          .filter((chunk) => chunk.needsEmbedding)
          .map((chunk) => [chunk.contentHash, chunk]),
      ).values(),
    ];
    const selected = [];
    for (const chunk of missing) {
      if (!Number.isInteger(chunk.tokenCount) || chunk.tokenCount < 1)
        throw new Error("Invalid chunk token count.");
      if (inputTokens + chunk.tokenCount > maxTokens) break;
      inputTokens += chunk.tokenCount;
      selected.push(chunk);
    }
    if (missing.length && !selected.length)
      return {
        indexed,
        embeddedChunks,
        inputTokens,
        conflicts,
        budgetReached: true,
      };
    let embeddings = [];
    if (selected.length) {
      const response = await gateway("embeddings", {
        model: page.embeddingModel,
        input: selected.map((chunk) => chunk.content),
        dimensions: 1536,
        encoding_format: "float",
      });
      const vectors = new Map();
      for (const item of response.data ?? []) {
        if (
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= selected.length ||
          vectors.has(item.index) ||
          !Array.isArray(item.embedding) ||
          item.embedding.length !== 1536 ||
          !item.embedding.every(
            (value) => typeof value === "number" && Number.isFinite(value),
          ) ||
          !item.embedding.some((value) => value !== 0)
        )
          throw new Error("Gateway returned invalid chunk embeddings.");
        vectors.set(item.index, item.embedding);
      }
      if (vectors.size !== selected.length)
        throw new Error("Gateway returned incomplete chunk embeddings.");
      embeddings = selected.map((chunk, index) => ({
        contentHash: chunk.contentHash,
        embedding: vectors.get(index),
      }));
      embeddedChunks += embeddings.length;
    }
    try {
      const result = unpack(
        await callTool({
          name: "index_chunks",
          arguments: {
            ref: page.id,
            expectedVersion: page.version,
            embeddingModel: page.embeddingModel,
            chunkerVersion: page.chunkerVersion,
            embeddings,
          },
        }),
      );
      if (result.indexed) indexed++;
      else if (!embeddings.length)
        throw new Error("Chunk indexing made no progress.");
    } catch (error) {
      if (error.code !== "VERSION_CONFLICT") throw error;
      conflicts++;
      if (conflicts >= 5)
        return {
          indexed,
          embeddedChunks,
          inputTokens,
          conflicts,
          budgetReached: true,
        };
    }
  }
  return {
    indexed,
    embeddedChunks,
    inputTokens,
    conflicts,
    budgetReached: true,
  };
}
