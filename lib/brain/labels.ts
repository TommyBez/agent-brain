import { LINK_TYPES, PAGE_TYPES, type PageType } from "@/lib/brain/types";
export const entityTypes: { id: PageType; label: string; singular: string }[] =
  PAGE_TYPES.map((id) => ({
    id,
    label: {
      person: "People",
      client: "Clients",
      project: "Projects",
      article: "Articles",
      decision: "Decisions",
      note: "Notes",
    }[id],
    singular: id.charAt(0).toUpperCase() + id.slice(1),
  }));
export const linkTypes = LINK_TYPES;
