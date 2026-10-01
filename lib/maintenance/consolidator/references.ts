import type { BrainPage } from "../../brain/types";
import type { Snapshot } from "./types";
export function explicitReferences(pages: BrainPage[]): Set<string> {
  return new Set(
    pages.flatMap((page) => [
      ...page.links
        .filter(
          (link) => link.type === "references" || link.type === "decided_in",
        )
        .map((link) => link.targetId),
      ...[...page.markdown.matchAll(/\/pages\/([\w/-]+)/g)].map((match) =>
        match[1].replace(/\/+$/, ""),
      ),
    ]),
  );
}

/** Resolve only explicit references to existing Brain pages; never search the corpus with Jev. */
export function referencedPages(
  snapshot: Snapshot,
  pages: BrainPage[],
): BrainPage[] {
  const references = explicitReferences(pages);
  return snapshot.pages.filter(
    (page) =>
      !pages.some((source) => source.id === page.id) &&
      (references.has(page.id) || references.has(page.slug)),
  );
}
