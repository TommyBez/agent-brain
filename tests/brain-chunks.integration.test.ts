import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CHUNKER_VERSION, chunkPage } from "../lib/brain/chunks";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { embeddingModel } from "../lib/brain/utils";
import { getPool } from "../lib/db";

const vector = (coordinate: number) =>
  Array.from({ length: 1536 }, (_, index) => Number(index === coordinate));

test(
  "complete chunk indexes, reuse, version safety and late-page context",
  {
    skip: process.env.RUN_DB_TESTS !== "1",
  },
  async (t) => {
    const owner = `chunk-test-${randomUUID()}`;
    const outsider = `chunk-test-${randomUUID()}`;
    const tail = "The final recovery password is CANARY-VIOLET-ORBIT.";
    const markdown = `${Array.from(
      { length: 90 },
      (_, index) =>
        `## Section ${index}\n\nA numbered planning section ${index} describes ordinary project records. ${"The archive contains annual operational notes. ".repeat(9)}`,
    ).join("\n\n")}\n\n## Recovery instructions\n\n${tail}`;
    const model = embeddingModel();
    try {
      let page = await brain.write(owner, {
        title: "Extensive archive",
        type: "article",
        markdown,
        expectedVersion: 0,
      });
      const manifest = chunkPage(page);
      assert.ok(manifest.length > 8);
      const inputs = [
        ...new Map(
          manifest.map((chunk) => [
            chunk.contentHash,
            {
              contentHash: chunk.contentHash,
              embedding: vector(chunk.content.includes(tail) ? 0 : 1),
            },
          ]),
        ).values(),
      ];
      const indexInput = {
        ref: page.id,
        expectedVersion: 1,
        embeddingModel: model,
        chunkerVersion: CHUNKER_VERSION,
      };

      await t.test(
        "bounded pending manifests and invalid hashes cannot publish an incomplete page",
        async () => {
          const [pending] = await brain.listPendingEmbeddings(owner, 1, 2);
          assert.equal(pending.id, page.id);
          assert.equal(pending.chunks.length, 2);
          assert.equal(pending.totalChunks, manifest.length);
          assert.equal("markdown" in pending, false);
          const first = await brain.indexChunks(owner, {
            ...indexInput,
            embeddings: inputs.slice(0, 1),
          });
          assert.equal(first.indexed, false);
          assert.ok(first.pendingChunks > 0);
          await assert.rejects(
            brain.indexChunks(owner, {
              ...indexInput,
              embeddings: [
                { contentHash: "f".repeat(64), embedding: vector(0) },
              ],
            }),
            (error) =>
              error instanceof BrainError &&
              error.code === "INVALID_CHUNK_MANIFEST",
          );
          const matches = await brain.search(owner, {
            query: "absent-lexical-query",
            embedding: vector(0),
            embeddingModel: model,
            expandGraph: false,
          });
          assert.equal(
            matches.length,
            0,
            "staged sections must not become retrieval candidates",
          );
          const count = await getPool().query(
            "SELECT count(*)::int AS count FROM brain_page_chunks WHERE owner_id=$1 AND page_id=$2",
            [owner, page.id],
          );
          assert.equal(count.rows[0].count, first.indexedChunks);
        },
      );

      await t.test(
        "all batches publish together, with one result per page and a cited tail passage",
        async () => {
          for (let offset = 1; offset < inputs.length; offset += 32)
            await brain.indexChunks(owner, {
              ...indexInput,
              embeddings: inputs.slice(offset, offset + 32),
            });
          const final = await brain.indexChunks(owner, {
            ...indexInput,
            embeddings: [],
          });
          assert.equal(final.indexed, true);
          assert.equal(final.totalChunks, manifest.length);
          assert.equal(final.pendingChunks, 0);
          assert.equal((await brain.listPendingEmbeddings(owner)).length, 0);
          await brain.write(outsider, {
            title: "Private archive",
            type: "article",
            markdown: tail,
            expectedVersion: 0,
            embedding: vector(0),
            embeddingModel: model,
          });
          const matches = await brain.search(owner, {
            query: "unmatched-semantic-probe",
            embedding: vector(0),
            embeddingModel: model,
            expandGraph: false,
          });
          assert.equal(matches.length, 1);
          assert.equal(matches[0].id, page.id);
          assert.deepEqual(matches[0].matchedBy, ["vector"]);
          assert.ok(matches[0].excerpt.includes(tail));
          assert.ok((matches[0].matchedPassage?.startOffset ?? 0) > 7500);
          const bundle = await brain.context(owner, {
            query: "unmatched-semantic-probe",
            embedding: vector(0),
            embeddingModel: model,
            maxCharacters: 8000,
          });
          assert.ok(bundle.markdown.includes(tail));
          assert.ok(bundle.markdown.length <= 8000);
          assert.equal(bundle.citations.length, 1);
          assert.ok(bundle.citations[0].startOffset > 7500);
          assert.equal(bundle.citations[0].version, 1);
        },
      );

      await t.test(
        "edits hide old chunks immediately and reject stale worker writes while reusing unchanged sections",
        async () => {
          page = await brain.append(owner, {
            ref: page.id,
            expectedVersion: 1,
            markdown:
              "## New addendum\n\nThe updated backup key is JADE-CLOUD.",
          });
          const matches = await brain.search(owner, {
            query: "unmatched-semantic-probe",
            embedding: vector(0),
            embeddingModel: model,
            expandGraph: false,
          });
          assert.equal(matches.length, 0);
          await assert.rejects(
            brain.indexChunks(owner, {
              ...indexInput,
              embeddings: inputs.slice(0, 1),
            }),
            (error) =>
              error instanceof BrainError && error.code === "VERSION_CONFLICT",
          );
          const pending = (await brain.listPendingEmbeddings(owner)).find(
            (item) => item.id === page.id,
          );
          assert.ok(pending);
          assert.ok(pending.chunks.some((chunk) => !chunk.needsEmbedding));
          assert.ok(pending.chunks.some((chunk) => chunk.needsEmbedding));
          const missing = [
            ...new Map(
              pending.chunks
                .filter((chunk) => chunk.needsEmbedding)
                .map((chunk) => [
                  chunk.contentHash,
                  {
                    contentHash: chunk.contentHash,
                    embedding: vector(chunk.content.includes(tail) ? 0 : 1),
                  },
                ]),
            ).values(),
          ];
          let result: Awaited<ReturnType<typeof brain.indexChunks>> | undefined;
          for (let offset = 0; offset < missing.length; offset += 32)
            result = await brain.indexChunks(owner, {
              ...indexInput,
              expectedVersion: 2,
              embeddings: missing.slice(offset, offset + 32),
            });
          assert.equal(result?.indexed, true);
          assert.ok((result?.reusedChunks ?? 0) > 0);
          const versions = await getPool().query(
            "SELECT DISTINCT page_version FROM brain_page_chunks WHERE owner_id=$1 AND page_id=$2",
            [owner, page.id],
          );
          assert.deepEqual(
            versions.rows.map((row) => row.page_version),
            [2],
          );
        },
      );

      await t.test(
        "metadata-only matches retain their evidence and respect the context budget",
        async () => {
          const metadataFact =
            "METADATA-CANARY-AMBER is the approved recovery owner.";
          const metadataPage = await brain.write(owner, {
            title: "Multilingual metadata record",
            type: "note",
            summary: `${"🧬".repeat(700)} ${metadataFact}`,
            markdown:
              "The canonical body remains available after its matching metadata.",
            expectedVersion: 0,
          });
          const chunks = chunkPage(metadataPage);
          const metadataChunks = chunks.filter(
            (chunk) => chunk.startOffset === 0 && chunk.endOffset === 0,
          );
          assert.ok(
            metadataChunks.length > 1,
            "fixture metadata must exceed a single token-bounded section",
          );
          assert.ok(
            metadataChunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0) >
              1200,
          );
          const embeddings = [
            ...new Map(
              chunks.map((chunk) => [
                chunk.contentHash,
                {
                  contentHash: chunk.contentHash,
                  embedding: vector(
                    chunk.startOffset === 0 &&
                      chunk.endOffset === 0 &&
                      chunk.content.includes(metadataFact)
                      ? 4
                      : 5,
                  ),
                },
              ]),
            ).values(),
          ];
          await brain.indexChunks(owner, {
            ref: metadataPage.id,
            expectedVersion: 1,
            embeddingModel: model,
            chunkerVersion: CHUNKER_VERSION,
            embeddings,
          });
          const input = {
            query: "metadata-semantic-probe",
            embedding: vector(4),
            embeddingModel: model,
            limit: 1,
          };
          const bundle = await brain.context(owner, {
            ...input,
            maxCharacters: 8000,
          });
          assert.equal(bundle.citations[0].id, metadataPage.id);
          assert.ok(bundle.markdown.includes(metadataFact));
          assert.ok(bundle.markdown.includes(metadataPage.markdown));
          assert.ok(bundle.markdown.length <= 8000);
          assert.equal(bundle.citations[0].startOffset, 0);
          assert.equal(
            bundle.citations[0].endOffset,
            metadataPage.markdown.length,
          );
          const small = await brain.context(owner, {
            ...input,
            maxCharacters: 1000,
          });
          assert.ok(small.markdown.length <= 1000);
        },
      );

      await t.test(
        "legacy vectors stay compatible but never mark full-page coverage complete",
        async () => {
          const legacy = await brain.write(owner, {
            title: "Legacy index",
            type: "note",
            markdown: "Short legacy page",
            expectedVersion: 0,
            embedding: vector(2),
            embeddingModel: model,
          });
          assert.ok(
            (await brain.listPendingEmbeddings(owner)).some(
              (item) => item.id === legacy.id,
            ),
          );
          const matches = await brain.search(owner, {
            query: "unmatched-semantic-probe",
            embedding: vector(2),
            embeddingModel: model,
            expandGraph: false,
          });
          assert.equal(matches[0].id, legacy.id);
          await assert.rejects(
            brain.indexChunks(outsider, {
              ref: page.id,
              expectedVersion: 2,
              embeddingModel: model,
              chunkerVersion: CHUNKER_VERSION,
              embeddings: [],
            }),
            (error) =>
              error instanceof BrainError && error.code === "NOT_FOUND",
          );
          await assert.rejects(
            brain.indexChunks(owner, {
              ref: page.id,
              expectedVersion: 2,
              embeddingModel: "another/model",
              chunkerVersion: CHUNKER_VERSION,
              embeddings: [],
            }),
            (error) =>
              error instanceof BrainError &&
              error.code === "EMBEDDING_MODEL_MISMATCH",
          );
        },
      );
    } finally {
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().end();
    }
  },
);
