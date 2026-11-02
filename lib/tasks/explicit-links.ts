import type { LinkWrite } from "./page-links";
export function contextLinks(
  pages: { id: string; version: number }[],
  origin: "owner" | "agent",
  mention = false,
): LinkWrite[] {
  return pages.map((page) => ({
    pageId: page.id,
    role: "context",
    origin,
    status: "active",
    evidence: {
      basis: "reference",
      pageVersion: page.version,
      ...(mention ? { mention: true } : {}),
    },
  }));
}
