import type {
  CompanyRelationship,
  DecoratedPage,
  LinkType,
  PageType,
} from "../brain/types";
export type DraftLink = {
  targetRef: string;
  type: LinkType;
  label: string;
  targetTitle?: string;
};

export type PageDraft = {
  title: string;
  type: PageType;
  summary: string;
  relationships: CompanyRelationship[];
  markdown: string;
  aliases: string;
  tags: string;
  reason: string;
  links: DraftLink[];
};
export function draftFromPage(
  page: DecoratedPage | null,
  fallbackType: PageType,
  fallbackRelationships: CompanyRelationship[] = [],
): PageDraft {
  return {
    title: page?.title ?? "",
    type: page?.type ?? fallbackType,
    summary: page?.summary ?? "",
    relationships: page?.relationships ?? fallbackRelationships,
    markdown: page?.markdown ?? "",
    aliases: page?.aliases.join(", ") ?? "",
    tags: page?.tags.join(", ") ?? "",
    reason: "",
    links:
      page?.links.map((link) => ({
        targetRef: link.targetId,
        type: link.type,
        label: link.label || "",
        targetTitle: link.targetTitle,
      })) ?? [],
  };
}
