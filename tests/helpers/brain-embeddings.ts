import { CHUNKER_VERSION, chunkPage } from "../../lib/brain/chunks";
import { indexChunks } from "../../lib/brain/service";
import type { BrainPage } from "../../lib/brain/types";
import { embeddingModel } from "../../lib/brain/utils";

export async function indexPageFixture(
  ownerId: string,
  page: BrainPage,
  embedding: number[],
) {
  const embeddings = [
    ...new Map(
      chunkPage(page).map(({ contentHash }) => [
        contentHash,
        { contentHash, embedding },
      ]),
    ).values(),
  ];
  for (let offset = 0; offset < embeddings.length; offset += 32) {
    await indexChunks(ownerId, {
      ref: page.id,
      expectedVersion: page.version,
      embeddingModel: embeddingModel(),
      chunkerVersion: CHUNKER_VERSION,
      embeddings: embeddings.slice(offset, offset + 32),
    });
  }
}
