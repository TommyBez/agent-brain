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

/** Explicit owner-confirmed decisions, with the same provenance as addTaskLink. */
export function ownerDecisionLinks(
  pages: { id: string; version: number }[],
): LinkWrite[] {
  return pages.map((page) => ({
    pageId: page.id,
    role: "decision",
    origin: "owner",
    status: "active",
    evidence: { basis: "reference", pageVersion: page.version },
  }));
}
