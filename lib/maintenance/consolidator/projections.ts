import type { BrainPage } from "../../brain/types";

/** Only source-owned semantic data participates in model inputs and cache keys. */
export function evidencePage(page: BrainPage) {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    type: page.type,
    summary: page.summary,
    relationships: page.relationships,
    aliases: page.aliases,
    tags: page.tags,
    markdown: page.markdown,
    links: page.links
      .map(({ sourceId, targetId, type, label }) => ({
        sourceId,
        targetId,
        type,
        label,
      }))
      .sort(
        (a, b) =>
          a.targetId.localeCompare(b.targetId) || a.type.localeCompare(b.type),
      ),
  };
}

/** Only source-owned, versioned fields are evidence; joined display fields are not. */
export function projectEvidencePage(page: BrainPage) {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    type: page.type,
    summary: page.summary,
    relationships: page.relationships,
    aliases: page.aliases,
    tags: page.tags,
    version: page.version,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    markdown: page.markdown,
    links: page.links
      .filter((link) => link.sourceId === page.id)
      .map((link) => ({
        sourceId: link.sourceId,
        targetId: link.targetId,
        type: link.type,
        label: link.label,
      })),
  };
}
