import { createHash } from "node:crypto";
import type { BrainPage } from "../../brain/types";
import {
  type AnalysisTask,
  type EvidenceUnit,
  POLICY,
  type Snapshot,
} from "./types";

export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");
}

export function pageEvidenceFingerprint({
  embeddedAt: _embeddedAt,
  backlinks: _backlinks,
  ...evidence
}: BrainPage): string {
  return fingerprint(evidence);
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
        id: `${page.id}:${page.version}:${start}:${fingerprint(source).slice(0, 12)}`,
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
export function buildSnapshot(
  pages: BrainPage[],
  createdAt = new Date().toISOString(),
): Snapshot {
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
    createdAt,
    pages: ordered,
    units: ordered.flatMap(segmentPage),
  };
}

function windows(units: EvidenceUnit[]): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const unit of units) {
    const size =
      unit.text.length + unit.context.length + unit.headings.join("/").length;
    if (
      current.length &&
      (characters + size > POLICY.windowCharacters ||
        current.length === POLICY.windowUnits)
    ) {
      result.push(current);
      current = [];
      characters = 0;
    }
    current.push(unit.id);
    characters += size;
  }
  if (current.length) result.push(current);
  return result.length ? result : [[]];
}

/** Includes cross-window pairs within a long document, not just adjacent windows. */
export function createAnalysisTasks(
  snapshot: Snapshot,
  changedPageIds?: string[],
): AnalysisTask[] {
  const changed = changedPageIds ? new Set(changedPageIds) : null;
  const pageEvidence = new Map(
    snapshot.pages.map((page) => [page.id, pageEvidenceFingerprint(page)]),
  );
  const pageWindows = snapshot.pages.map((page) => ({
    page,
    windows: windows(snapshot.units.filter((unit) => unit.pageId === page.id)),
  }));
  const tasks: AnalysisTask[] = [];
  const add = (
    kind: AnalysisTask["kind"],
    pageIds: string[],
    unitIds: string[],
    crossWindow?: AnalysisTask["crossWindow"],
  ) => {
    const selectedUnitIds = [...new Set(unitIds)];
    tasks.push({
      id: fingerprint({
        policy: POLICY.version,
        kind,
        pages: pageIds.map((id) => pageEvidence.get(id)),
        unitIds: selectedUnitIds,
        ...(crossWindow ? { crossWindow } : {}),
      }),
      kind,
      pageIds,
      unitIds: selectedUnitIds,
      ...(crossWindow ? { crossWindow } : {}),
    });
  };
  for (let a = 0; a < pageWindows.length; a++) {
    const left = pageWindows[a];
    if (!changed || changed.has(left.page.id)) {
      for (let i = 0; i < left.windows.length; i++) {
        for (let j = i; j < left.windows.length; j++)
          add(
            "document",
            [left.page.id],
            [...left.windows[i], ...left.windows[j]],
            i === j ? undefined : [left.windows[i], left.windows[j]],
          );
      }
    }
    for (let b = a + 1; b < pageWindows.length; b++) {
      const right = pageWindows[b];
      if (changed && !changed.has(left.page.id) && !changed.has(right.page.id))
        continue;
      for (const l of left.windows)
        for (const r of right.windows)
          add("pair", [left.page.id, right.page.id], [...l, ...r]);
    }
  }
  return tasks;
}
