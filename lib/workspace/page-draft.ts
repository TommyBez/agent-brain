import type { DecoratedPage, LinkType, PageType } from "../brain/types";
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
  markdown: string;
  aliases: string;
  tags: string;
  reason: string;
  links: DraftLink[];
};
export function draftFromPage(
  page: DecoratedPage | null,
  fallbackType: PageType,
): PageDraft {
  return {
    title: page?.title ?? "",
    type: page?.type ?? fallbackType,
    summary: page?.summary ?? "",
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
