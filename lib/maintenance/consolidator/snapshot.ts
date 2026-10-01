import type { BrainPage } from "../../brain/types";
import { fingerprint } from "../../canonical-json";
import { evidencePage } from "./projections";
import {
  type AnalysisTask,
  type EvidenceUnit,
  POLICY,
  type Snapshot,
} from "./types";

export function pageEvidenceFingerprint(page: BrainPage): string {
  return fingerprint(evidencePage(page));
}

/** Exact, non-overlapping UTF-16 ranges; context never becomes editable source. */
export function segmentPage(page: BrainPage): EvidenceUnit[] {
  const text = page.markdown;
  if (!text) return [];
  const lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)].map((match) => ({
    start: match.index,
    text: match[0],
  }));
  const boundaries = new Set<number>([0, text.length]);
  const contexts: { start: number; headings: string[]; structure: string }[] =
    [];
  const headings: { level: number; title: string }[] = [];
  let fence: string | null = null;
  let structure = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text)?.[1];
    if (fence) {
      if (
        fenceMark &&
        fenceMark[0] === fence[0] &&
        fenceMark.length >= fence.length
      ) {
        fence = null;
        boundaries.add(line.start + line.text.length);
        structure = "";
      }
      continue;
    }
    if (fenceMark) {
      boundaries.add(line.start);
      fence = fenceMark;
      structure = line.text.trimEnd();
    } else {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.text.trimEnd());
      if (heading) {
        const level = heading[1].length;
        while (headings.length && headings[headings.length - 1].level >= level)
          headings.pop();
        headings.push({ level, title: heading[2] });
        boundaries.add(line.start);
        boundaries.add(line.start + line.text.length);
        structure = "";
      } else if (/^\s*$/.test(line.text)) {
        boundaries.add(line.start + line.text.length);
        structure = "";
      } else if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line.text)) {
        boundaries.add(line.start);
      } else if (
        index + 1 < lines.length &&
        line.text.includes("|") &&
        /^\s*\|?\s*:?-{3,}/.test(lines[index + 1].text)
      ) {
        boundaries.add(line.start);
        structure = line.text + lines[index + 1].text;
      }
    }
    contexts.push({
      start: line.start,
      headings: headings.map(({ title }) => title),
      structure,
    });
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  const units: EvidenceUnit[] = [];
  let contextIndex = 0;
  for (let i = 1; i < ordered.length; i++) {
    let start = ordered[i - 1];
    while (start < ordered[i]) {
      let end = Math.min(ordered[i], start + POLICY.maxUnitCharacters);
      if (end < ordered[i]) {
        const newline = text.lastIndexOf("\n", end - 1) + 1;
        if (newline > start + POLICY.maxUnitCharacters / 2) end = newline;
        if (
          /[\uD800-\uDBFF]/.test(text[end - 1]) &&
          /[\uDC00-\uDFFF]/.test(text[end])
        )
          end--;
      }
      while (
        contextIndex + 1 < contexts.length &&
        contexts[contextIndex + 1].start <= start
      )
        contextIndex++;
      const context = contexts[contextIndex];
      const source = text.slice(start, end);
      units.push({
        id: `${page.id}:${start}:${fingerprint(source).slice(0, 12)}`,
        pageId: page.id,
        start,
        end,
        text: source,
        headings: context?.headings ?? [],
        context: context?.structure ?? "",
      });
      start = end;
    }
  }
  return units;
}

/** Sorting and cloning make snapshot identity independent from read ordering. */
export function buildSnapshot(pages: BrainPage[]): Snapshot {
  const ordered = structuredClone(pages).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (new Set(ordered.map((page) => page.id)).size !== ordered.length)
    throw new Error("Duplicate snapshot page ID");
  for (const page of ordered) {
    page.links.sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.targetId.localeCompare(b.targetId),
    );
    page.backlinks.sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.sourceId.localeCompare(b.sourceId),
    );
  }
  return {
    // Evidence identity excludes operational state and decision thresholds.
    // Tasks/plans carry POLICY.version separately; exact judgments remain reusable.
    id: fingerprint({
      pages: ordered.map(
        ({ embeddedAt: _embeddedAt, ...evidence }) => evidence,
      ),
    }),
    createdAt: new Date().toISOString(),
    pages: ordered,
    units: ordered.flatMap(segmentPage),
  };
}

/** A task always owns one complete page or one unordered pair, never windows. */
export function createAnalysisTasks(snapshot: Snapshot): AnalysisTask[] {
  const tasks: AnalysisTask[] = [];
  const add = (pages: BrainPage[]) =>
    tasks.push({
      id: fingerprint({
        policy: POLICY.version,
        pages: pages.map(pageEvidenceFingerprint),
      }),
      kind: pages.length === 1 ? "document" : "pair",
      pageIds: pages.map((page) => page.id),
    });
  for (let a = 0; a < snapshot.pages.length; a++) {
    add([snapshot.pages[a]]);
    for (let b = a + 1; b < snapshot.pages.length; b++)
      add([snapshot.pages[a], snapshot.pages[b]]);
  }
  return tasks;
}
