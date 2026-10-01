import {
  COMPANY_RELATIONSHIPS,
  type CompanyRelationship,
  LINK_TYPES,
  PAGE_TYPES,
  type PageType,
} from "@/lib/brain/types";
export const entityTypes: { id: PageType; label: string; singular: string }[] =
  PAGE_TYPES.map((id) => ({
    id,
    label: {
      person: "People",
      company: "Companies",
      project: "Projects",
      article: "Articles",
      decision: "Decisions",
      note: "Notes",
    }[id],
    singular: id.charAt(0).toUpperCase() + id.slice(1),
  }));
export const relationshipLabels: Record<CompanyRelationship, string> = {
  client: "Client",
  prospect: "Prospect",
  former_employer: "Former employer",
};
export const companyRelationships = COMPANY_RELATIONSHIPS.map((id) => ({
  id,
  label: relationshipLabels[id],
}));
export const linkTypes = LINK_TYPES;
