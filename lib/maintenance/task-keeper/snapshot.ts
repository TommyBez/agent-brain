import type { BrainPage, PageType } from "../../brain/types";
import { fingerprint } from "../../canonical-json";
import { pageEvidenceFingerprint, segmentPage } from "../consolidator/snapshot";
import type { EvidenceUnit } from "../consolidator/types";
import { TASK_KEEPER_POLICY } from "./prompts";

// One source page as the task keeper reads it: evidence metadata, exact
// passages (the consolidator's segmentation) and the person and project
// pages it links to. Excerpts are always cut from these units by code.

export interface KeeperLinkedPage {
  id: string;
  slug: string;
  title: string;
  type: PageType;
  aliases: string[];
}

export interface KeeperSnapshot {
  page: {
    id: string;
    slug: string;
    title: string;
    type: PageType;
    summary: string;
    tags: string[];
    aliases: string[];
    version: number;
  };
  evidenceFingerprint: string;
  /** Binds the page's evidence to the keeper policy; a stored unit means done. */
  unitId: string;
  units: EvidenceUnit[];
  linked: KeeperLinkedPage[];
}

export function keeperUnitId(evidenceFingerprint: string): string {
  return fingerprint({
    policy: TASK_KEEPER_POLICY.version,
    page: evidenceFingerprint,
  });
}

export function keeperPageUnit(page: BrainPage) {
  const evidenceFingerprint = pageEvidenceFingerprint(page);
  return { evidenceFingerprint, unitId: keeperUnitId(evidenceFingerprint) };
}

/** Linked page ids in both directions (person and project candidates). */
export function linkedPageIds(page: BrainPage): string[] {
  return [
    ...new Set([
      ...page.links.map((link) => link.targetId),
      ...page.backlinks.map((link) => link.sourceId),
    ]),
  ].filter((id) => id !== page.id);
}

export function buildKeeperSnapshot(
  page: BrainPage,
  linked: KeeperLinkedPage[],
): KeeperSnapshot {
  const unit = keeperPageUnit(page);
  return {
    page: {
      id: page.id,
      slug: page.slug,
      title: page.title,
      type: page.type,
      summary: page.summary,
      tags: [...page.tags],
      aliases: [...page.aliases],
      version: page.version,
    },
    ...unit,
    units: segmentPage(page),
    linked: [...linked].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** The page Markdown, reassembled from its contiguous units. */
export function snapshotMarkdown(snapshot: KeeperSnapshot): string {
  return snapshot.units.map((unit) => unit.text).join("");
}

export interface Excerpt {
  startOffset: number;
  endOffset: number;
  /** The cited passages' exact text, joined in source order. */
  text: string;
}

/** Excerpt of the cited units, taken from the snapshot, never from a model. */
export function excerptOf(
  snapshot: KeeperSnapshot,
  passages: number[],
): Excerpt {
  const units = [...new Set(passages)]
    .sort((a, b) => a - b)
    .map((index) => snapshot.units[index])
    .filter((unit): unit is EvidenceUnit => unit !== undefined);
  if (!units.length) throw new Error("An excerpt needs at least one passage");
  return {
    startOffset: units[0].start,
    endOffset: units[units.length - 1].end,
    text: units
      .map((unit) => unit.text.trim())
      .filter(Boolean)
      .join("\n…\n"),
  };
}
