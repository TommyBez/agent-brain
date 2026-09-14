import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import {
  CHUNKER_VERSION,
  chunkPage,
  MAX_CHUNK_TOKENS,
  type PageChunk,
} from "../lib/brain/chunks";

function verifyCoverage(markdown: string, chunks: PageChunk[]) {
  let covered = 0;
  let reconstructed = "";
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.index, index);
    assert.equal(
      chunk.contentHash,
      createHash("sha256").update(chunk.content).digest("hex"),
    );
    assert.equal(
      chunk.tokenCount,
      encode(chunk.content, { disallowedSpecial: new Set() }).length,
    );
    assert.ok(chunk.tokenCount > 0 && chunk.tokenCount <= MAX_CHUNK_TOKENS);
    assert.equal(chunk.content, chunk.content.toWellFormed());
    if (chunk.endOffset === 0) continue;
    assert.ok(chunk.startOffset <= covered, "No gaps between source ranges");
    assert.ok(chunk.endOffset > covered, "Every body chunk advances coverage");
    assert.ok(chunk.endOffset <= markdown.length);
    assert.ok(
      chunk.content.endsWith(
        markdown.slice(chunk.startOffset, chunk.endOffset),
      ),
      "Embedding input contains the exact original source range",
    );
    reconstructed += markdown.slice(covered, chunk.endOffset);
    covered = chunk.endOffset;
  }
  assert.equal(covered, markdown.length);
  assert.equal(reconstructed, markdown);
}

test("short pages preserve exact Markdown, metadata and deterministic hashes", () => {
  const page = {
    title: "A decision",
    summary: "Why we made it",
    markdown: "# A decision\r\n\r\nThe answer is **42**.\r\n",
  };
  const chunks = chunkPage(page);
  assert.equal(chunks.length, 1);
  assert.ok(CHUNKER_VERSION.length > 0);
  assert.ok(chunks[0].content.includes(`Title: ${page.title}`));
  assert.ok(chunks[0].content.includes(`Summary: ${page.summary}`));
  assert.deepEqual(chunkPage(page), chunks);
  verifyCoverage(page.markdown, chunks);
});

test("long pages include the tail past 7,500 bytes with bounded overlap", () => {
  const markdown = `${Array.from(
    { length: 180 },
    (_, index) =>
      `Paragraph ${index}: ${"A specific project decision needs its supporting evidence. ".repeat(5)}\n\n`,
  ).join("")}THE UNIQUE FINAL DECISION: use a portable archive.`;
  const chunks = chunkPage({ title: "Long page", summary: "", markdown });
  assert.ok(Buffer.byteLength(markdown, "utf8") > 7500);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.at(-1)?.content.includes("THE UNIQUE FINAL DECISION"));
  verifyCoverage(markdown, chunks);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].startOffset < chunks[i - 1].endOffset);
    const overlap = markdown.slice(
      chunks[i].startOffset,
      chunks[i - 1].endOffset,
    );
    assert.ok(encode(overlap).length <= 100);
  }
});

test("emoji, CJK, combining marks, code and literal special tokens are lossless", () => {
  const markdown =
    "# Unicode\n\n" +
    "猫🌎👩🏽‍💻 café e\u0301 汉字 العربية <|endoftext|> <|fim_prefix|>\n".repeat(
      600,
    ) +
    "\n```typescript\n" +
    "const unique = '🦕';\n".repeat(1000) +
    "```\nLAST 🌋";
  const chunks = chunkPage({ title: "🧠", summary: "", markdown });
  verifyCoverage(markdown, chunks);
  assert.ok(chunks.at(-1)?.content.endsWith("LAST 🌋"));
});

test("large multilingual metadata gets complete chunks instead of truncation", () => {
  const title = "🧠".repeat(100);
  const summary = Array.from({ length: 400 }, (_, i) => `${i}猫`).join("");
  assert.ok(summary.length <= 2000);
  const markdown = "The body remains a canonical Markdown page.";
  const chunks = chunkPage({ title, summary, markdown });
  const metadataChunks = chunks.filter((chunk) => chunk.endOffset === 0);
  assert.ok(metadataChunks.length >= 2);
  for (let offset = 0; offset < summary.length; offset += 12)
    assert.ok(
      metadataChunks.some((chunk) =>
        chunk.content.includes(summary.slice(offset, offset + 12)),
      ),
      `Missing summary segment at ${offset}`,
    );
  assert.ok(metadataChunks.some((chunk) => chunk.content.includes(title)));
  verifyCoverage(markdown, chunks);
});

test("editing an early section preserves hashes for unchanged later sections", () => {
  const section = (name: string) =>
    `# ${name}\n\n${`${name} has independently documented evidence. `.repeat(300)}\n\n`;
  const page = {
    title: "Stable pages",
    summary: "",
    markdown: section("Alpha") + section("Beta") + section("Gamma"),
  };
  const original = chunkPage(page);
  const edited = chunkPage({
    ...page,
    markdown: page.markdown.replace("Alpha has", "Alpha now has more"),
  });
  const originalTail = original.filter((chunk) =>
    chunk.content.includes("Gamma has independently"),
  );
  assert.ok(originalTail.length >= 2);
  const nextHashes = new Set(edited.map((chunk) => chunk.contentHash));
  assert.ok(originalTail.every((chunk) => nextHashes.has(chunk.contentHash)));
});

test("maximum-size unbroken inputs have full coverage and bounded running time", () => {
  const started = performance.now();
  for (const markdown of [
    "a".repeat(200_000),
    " ".repeat(200_000),
    "猫🌎".repeat(66_666),
  ]) {
    const chunks = chunkPage({ title: "Maximum input", summary: "", markdown });
    verifyCoverage(markdown, chunks);
  }
  // Catches accidental repeated tokenization of the entire remaining document.
  assert.ok(performance.now() - started < 10_000);
});

test("empty Markdown still embeds all available metadata", () => {
  const chunks = chunkPage({
    title: "Metadata only",
    summary: "",
    markdown: "",
  });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].content.includes("Metadata only"));
  verifyCoverage("", chunks);
});
