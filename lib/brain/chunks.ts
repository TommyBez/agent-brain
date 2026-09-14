import { createHash } from "node:crypto";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";

// text-embedding-3-small uses cl100k_base. Change this version whenever the
// tokenizer, source formatting, or splitting rules change so old indexes expire.
export const CHUNKER_VERSION = "cl100k-paragraph-v1";
export const MAX_CHUNK_TOKENS = 1200;
const CORE_TOKENS = 900;
const OVERLAP_TOKENS = 100;
const CONTEXT_TOKENS = 160;
const WINDOW_CHARACTERS = 8192;
const MAX_CORE_CHARACTERS = 32_768;
const tokenOptions = { disallowedSpecial: new Set<string>() };

export type PageChunk = {
  index: number;
  content: string;
  contentHash: string;
  /** UTF-16 offsets into the original Markdown; metadata chunks use 0, 0. */
  startOffset: number;
  endOffset: number;
  tokenCount: number;
};

function tokenCount(text: string) {
  // Literal tokenizer control-token spellings in Markdown are ordinary text.
  return encode(text, tokenOptions).length;
}

function safeBoundary(text: string, offset: number) {
  if (
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  )
    return offset - 1;
  return offset;
}

/** Find a fitting source prefix without decoding partial UTF-8 tokens. */
function fittingEnd(
  text: string,
  start: number,
  end: number,
  limit: number,
  prefix = "",
) {
  let low = start;
  let high = safeBoundary(text, end);
  if (tokenCount(prefix + text.slice(start, high)) <= limit) return high;
  while (low < high) {
    const middle = safeBoundary(text, Math.ceil((low + high) / 2));
    if (middle <= low) break;
    if (tokenCount(prefix + text.slice(start, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return low;
}

function overlapStart(text: string, start: number, end: number) {
  // The bounded window avoids rescanning a giant low-token paragraph.
  let low = safeBoundary(text, Math.max(start, end - WINDOW_CHARACTERS));
  let high = end;
  if (tokenCount(text.slice(low, end)) <= OVERLAP_TOKENS) return low;
  while (low < high) {
    const middle = safeBoundary(text, Math.floor((low + high) / 2));
    if (middle <= low) break;
    if (tokenCount(text.slice(middle, end)) <= OVERLAP_TOKENS) high = middle;
    else low = middle + 1;
  }
  return high;
}

type Range = { start: number; end: number; tokens: number };

/** Paragraphs anchor boundaries; oversized paragraphs are split in bounded work. */
function coreRanges(text: string) {
  const boundaries = new Set<number>([0, text.length]);
  for (const match of text.matchAll(/\r?\n[\t ]*\r?\n/g))
    boundaries.add(match.index + match[0].length);
  const headings = new Set<number>();
  for (const match of text.matchAll(/^#{1,6}[\t ]+/gm)) {
    boundaries.add(match.index);
    headings.add(match.index);
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  const ranges: Range[] = [];
  let current: Range | undefined;
  const flush = () => {
    if (current) ranges.push(current);
    current = undefined;
  };
  for (let i = 1; i < ordered.length; i++) {
    let start = ordered[i - 1];
    const paragraphEnd = ordered[i];
    if (headings.has(start)) flush();
    while (start < paragraphEnd) {
      const candidate = safeBoundary(
        text,
        Math.min(paragraphEnd, start + WINDOW_CHARACTERS),
      );
      let end = fittingEnd(text, start, candidate, CORE_TOKENS);
      if (end <= start)
        throw new Error("A Unicode character exceeds chunk budget");
      // Preserve complete lines in a large code block/list when practical.
      if (end < paragraphEnd) {
        const lineEnd = text.lastIndexOf("\n", end - 1) + 1;
        if (lineEnd > start + (end - start) / 2) end = lineEnd;
      }
      const tokens = tokenCount(text.slice(start, end));
      if (
        current &&
        (current.tokens + tokens > CORE_TOKENS ||
          end - current.start > MAX_CORE_CHARACTERS)
      )
        flush();
      current = current
        ? { start: current.start, end, tokens: current.tokens + tokens }
        : { start, end, tokens };
      start = end;
    }
  }
  flush();
  return ranges;
}

/**
 * Index every Markdown character and all metadata without changing the page.
 * Repeated context is bounded; oversized metadata gets its own complete chunks.
 */
export function chunkPage(page: {
  title: string;
  summary: string;
  markdown: string;
}): PageChunk[] {
  const metadata = `Title: ${page.title}\nSummary: ${page.summary}`;
  const context = metadata.slice(
    0,
    fittingEnd(metadata, 0, metadata.length, CONTEXT_TOKENS),
  );
  const chunks: PageChunk[] = [];

  const addSource = (source: string, isMetadata: boolean) => {
    const prefix = `${context}\n\n${isMetadata ? "Metadata" : "Passage"}:\n`;
    let previousCoreStart = 0;
    for (const range of coreRanges(source)) {
      let coreStart = range.start;
      while (coreStart < range.end) {
        const start = overlapStart(source, previousCoreStart, coreStart);
        const end = fittingEnd(
          source,
          start,
          range.end,
          MAX_CHUNK_TOKENS,
          prefix,
        );
        if (end <= coreStart)
          throw new Error("Chunk overlap prevents progress");
        const content = prefix + source.slice(start, end);
        chunks.push({
          index: chunks.length,
          content,
          contentHash: createHash("sha256").update(content).digest("hex"),
          startOffset: isMetadata ? 0 : start,
          endOffset: isMetadata ? 0 : end,
          tokenCount: tokenCount(content),
        });
        previousCoreStart = coreStart;
        coreStart = end;
      }
    }
  };

  if (context.length < metadata.length || !page.markdown.length)
    addSource(metadata, true);
  if (page.markdown.length) addSource(page.markdown, false);
  return chunks;
}
