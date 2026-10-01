import type { BrainPage } from "../../brain/types";
import { invalid } from "./plan-validation";
import type { ChangeSet, Draft, OperationPlan, Snapshot } from "./types";

/** Destination spelling is preserved; a model cannot silently replace a source URL. */
function references(markdown: string): Set<string> {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/!?\[(?:\\.|[^\]\n])*\]\(\s*/g)) {
    const start = match.index + match[0].length;
    let end = start;
    if (markdown[start] === "<") {
      end = markdown.indexOf(">", start + 1);
      if (end > start) found.add(markdown.slice(start + 1, end));
      continue;
    }
    let parentheses = 0;
    while (end < markdown.length) {
      const character = markdown[end];
      if (character === "\\") {
        end += 2;
        continue;
      }
      if (/\s/.test(character)) break;
      if (character === "(") parentheses++;
      if (character === ")") {
        if (parentheses === 0) break;
        parentheses--;
      }
      end++;
    }
    if (end > start) found.add(markdown.slice(start, end));
  }
  for (const match of markdown.matchAll(
    /^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm,
  )) {
    found.add(match[1].replace(/^<|>$/g, ""));
  }
  for (const match of markdown.matchAll(/https?:\/\/[^\s<>"'`\]]+/g)) {
    let reference = match[0].replace(/[,.;:!?]+$/, "");
    while (
      reference.endsWith(")") &&
      [...reference.matchAll(/\)/g)].length >
        [...reference.matchAll(/\(/g)].length
    )
      reference = reference.slice(0, -1);
    found.add(reference);
  }
  return found;
}

function localTarget(reference: string, source: BrainPage, pages: BrainPage[]) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return undefined;
  const [path, fragment] = reference.split("#", 2);
  let cleanPath = path.split("?", 1)[0];
  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch {
    // Existing Markdown may contain literal percent signs; retain its path.
  }
  const key = cleanPath
    .replace(/^\/?pages\//, "")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  const page = !cleanPath
    ? source
    : pages.find((candidate) => candidate.id === key || candidate.slug === key);
  if (!page) return false;
  if (fragment) {
    // ReactMarkdown generates neither heading IDs nor raw-HTML anchors here.
    // Existing fragment spelling is preserved, but new fragments cannot be valid.
    return false;
  }
  return page;
}

export function validateReferences(
  snapshot: Snapshot,
  plan: OperationPlan,
  changes: ChangeSet["changes"],
  draft: Draft,
) {
  const afterPages = snapshot.pages.map(
    (page) =>
      changes.find((change) => change.after.id === page.id)?.after ?? page,
  );
  const originalReferences = new Set(
    snapshot.pages
      .filter((page) => plan.readSet.some((ref) => ref.pageId === page.id))
      .flatMap((page) => [...references(`${page.markdown}\n${page.summary}`)]),
  );
  const canonical = afterPages.find((page) => page.id === plan.canonicalPageId);
  const canonicalReferences = references(
    canonical ? `${canonical.markdown}\n${canonical.summary}` : "",
  );
  for (const { before, after } of changes) {
    const oldReferences = references(`${before.markdown}\n${before.summary}`);
    const newReferences = references(`${after.markdown}\n${after.summary}`);
    // A residue exception cannot remove a URL from unselected knowledge or the
    // summary. Strip only the exact selected units being patched for this check.
    let untouchedMarkdown = before.markdown;
    if (plan.kind === "remove_maintenance_residue") {
      const selected = snapshot.units
        .filter(
          (unit) =>
            unit.pageId === before.id &&
            plan.targetUnitIds.includes(unit.id) &&
            draft.patches.some((patch) => patch.unitId === unit.id),
        )
        .sort((a, b) => b.start - a.start);
      for (const unit of selected)
        untouchedMarkdown =
          untouchedMarkdown.slice(0, unit.start) +
          untouchedMarkdown.slice(unit.end);
    }
    const unselectedReferences = references(
      `${untouchedMarkdown}\n${before.summary}`,
    );
    for (const reference of oldReferences) {
      if (!newReferences.has(reference)) {
        const selectedResidueOnly =
          plan.kind === "remove_maintenance_residue" &&
          !unselectedReferences.has(reference);
        const moved =
          plan.kind === "centralize" && canonicalReferences.has(reference);
        const hasDestination =
          canonical &&
          [...newReferences].some((ref) => {
            const target = localTarget(ref, after, afterPages);
            return target && target.id === canonical.id;
          });
        if (!selectedResidueOnly && (!moved || !hasDestination))
          invalid("source or URL removed without planned centralization");
      }
    }
    for (const reference of newReferences) {
      if (!oldReferences.has(reference)) {
        const target = localTarget(reference, after, afterPages);
        if (target === false) invalid("unknown local link target or anchor");
        if (target && !plan.readSet.some((ref) => ref.pageId === target.id))
          invalid("new link target outside read set");
        if (target === undefined && !originalReferences.has(reference))
          invalid("new URL absent from original evidence");
      }
    }
    const definitions = new Set(
      [...after.markdown.matchAll(/^\s{0,3}\[([^\]\n]+)\]:/gm)].map((match) =>
        match[1].trim().toLowerCase(),
      ),
    );
    for (const match of after.markdown.matchAll(
      /\[([^\]\n]+)\]\[([^\]\n]*)\]/g,
    )) {
      if (
        !definitions.has((match[2] || match[1]).trim().toLowerCase()) &&
        !before.markdown.includes(match[0])
      )
        invalid("undefined Markdown reference");
    }
  }
  for (const [index, page] of afterPages.entries()) {
    const before = snapshot.pages[index];
    for (const reference of references(`${page.markdown}\n${page.summary}`)) {
      if (
        localTarget(reference, before, snapshot.pages) &&
        localTarget(reference, page, afterPages) === false
      )
        invalid("local link target or anchor was broken");
    }
  }
}
