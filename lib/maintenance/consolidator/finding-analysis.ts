import type { BrainPage } from "../../brain/types";
import { analystGates, LOCALIZATION_THRESHOLD } from "./decision-policy";
import { evidencePage } from "./projections";
import {
  booleanQuestion,
  choiceQuestion,
  pairPreparationQuestions,
  preparationQuestions,
} from "./questions";
import { explicitReferences, referencedPages } from "./references";
import type {
  AnalysisResult,
  AnalysisTask,
  Answer,
  EvidenceUnit,
  Finding,
  Question,
  Snapshot,
} from "./types";
export type FindingContext = {
  snapshot: Snapshot;
  task: AnalysisTask;
  pages: BrainPage[];
  units: EvidenceUnit[];
  passageState: unknown;
  ask(
    state: unknown,
    questions: Record<string, Question>,
  ): Promise<Record<string, Answer>>;
  add(finding: Omit<Finding, "id">): void;
  depend(pages: BrainPage[]): void;
  dependencies: NonNullable<AnalysisResult["dependencies"]>;
};
type PassageKind = "duplicate" | "conflict" | "residue";
async function localize(
  { ask, passageState, units, add, task }: FindingContext,
  kind: PassageKind,
  instruction: string,
) {
  // Linear localization, only after a positive whole-page signal.
  const localization = await ask(
    passageState,
    Object.fromEntries(
      units.map((_, i) => [
        `passage_${i}`,
        booleanQuestion(
          `Select whether units[${i}] ${instruction}. All passages of each page are supplied in units in source order; use them as the complete page context. This question identifies an edit target, not permission to remove it.`,
        ),
      ]),
    ),
  );
  const selected = units.filter((_, i) => {
    const answer = localization[`passage_${i}`];
    return (
      answer?.type === "boolean" && answer.probability >= LOCALIZATION_THRESHOLD
    );
  });
  if (!selected.length) {
    add({
      kind:
        kind === "duplicate"
          ? "deduplicate"
          : kind === "conflict"
            ? "reconcile"
            : "remove_maintenance_residue",
      status: "uncertain",
      pageIds: task.pageIds,
      unitIds: [],
      evidenceUnitIds: [],
      goal: "No precise intervention target established.",
    });
    return [];
  }
  return selected;
}
async function pairTargets(
  { task, ask, passageState }: FindingContext,
  selected: EvidenceUnit[],
  kind: "duplicate" | "conflict",
) {
  const pairs: { target: EvidenceUnit[]; direct: boolean }[] = [];
  const seen = new Set<string>();
  const directPair =
    selected.length === 2 &&
    (task.kind === "document" || selected[0].pageId !== selected[1].pageId);
  if (directPair) pairs.push({ target: selected, direct: true });
  else {
    const selections: { anchor: EvidenceUnit; options: EvidenceUnit[] }[] = [];
    const questions: Record<string, Question> = {};
    for (const anchor of selected) {
      const candidates = selected.filter(
        (unit) =>
          unit.id !== anchor.id &&
          (task.kind === "document" || unit.pageId !== anchor.pageId),
      );
      // Choice accepts at most 255 options, including none. Every option is visited.
      for (let start = 0; start < candidates.length; start += 254) {
        const options = candidates.slice(start, start + 254);
        const id = `partner_${selections.length}`;
        selections.push({ anchor, options });
        questions[id] = choiceQuestion(
          `For anchor passage ${anchor.id} in units, which of the candidate passages listed in this question's choices ${kind === "duplicate" ? "repeats factual information from that anchor" : "makes a claim apparently incompatible with that anchor about the same entity and scope"}? Identify the counterpart only; a supported correction or deletion is NOT required. Select none when no counterpart exists; shared topic alone is insufficient.`,
          Object.fromEntries([
            ["none", "No suitable partner."],
            ...options.map((unit, index) => [
              `p${index}`,
              `Passage ${unit.id} in units.`,
            ]),
          ]),
        );
      }
    }
    // These selections are independent and share the same complete page state.
    // Anchor/candidate identities belong in each question, not just its opaque key.
    const answers = await ask(passageState, questions);
    for (const [index, { anchor, options }] of selections.entries()) {
      const answer = answers[`partner_${index}`];
      const choice = analystGates.certainChoice(answer);
      if (!choice || choice === "none") continue;
      const partner = options[Number(choice.slice(1))];
      const key = [anchor.id, partner.id].sort().join("|");
      if (!seen.has(key)) {
        pairs.push({ target: [anchor, partner], direct: false });
        seen.add(key);
      }
    }
  }
  return pairs;
}
async function preparePair(
  ctx: FindingContext,
  kind: "duplicate" | "conflict",
  pair: { target: EvidenceUnit[]; direct: boolean },
) {
  const preparation = await ctx.ask(
    { pages: ctx.pages.map(evidencePage), target: pair.target },
    pair.direct ? pairPreparationQuestions(kind) : preparationQuestions(kind),
  );
  return pair.direct && !analystGates.yes(preparation.counterpart)
    ? null
    : preparation;
}
function findingBase(
  { snapshot, task }: FindingContext,
  target: EvidenceUnit[],
  evidencePages: BrainPage[],
) {
  return {
    pageIds: task.pageIds,
    unitIds: target.map((unit) => unit.id),
    evidenceUnitIds: snapshot.units
      .filter((unit) => evidencePages.some((page) => page.id === unit.pageId))
      .map((unit) => unit.id),
  };
}
export async function analyzeDuplicate(ctx: FindingContext) {
  const selected = await localize(
    ctx,
    "duplicate",
    "contains factual information substantially repeated by another passage in the supplied page or opposite page of this pair",
  );
  for (const pair of await pairTargets(ctx, selected, "duplicate")) {
    const preparation = await preparePair(ctx, "duplicate", pair);
    if (!preparation) continue;
    const target = pair.target;
    const base = findingBase(ctx, target, ctx.pages);
    const { add } = ctx;

    const destination =
      preparation.destination?.type === "choice"
        ? preparation.destination.choice
        : undefined;
    const keeper =
      destination === "a" || destination === "equivalent"
        ? target[0]
        : destination === "b"
          ? target[1]
          : undefined;
    const crossPage = target[0].pageId !== target[1].pageId;
    add({
      ...base,
      kind: crossPage ? "centralize" : "deduplicate",
      status:
        keeper && analystGates.yes(preparation.actionable)
          ? "supported"
          : "uncertain",
      ...(keeper
        ? {
            retainedUnitId: keeper.id,
            ...(crossPage ? { canonicalPageId: keeper.pageId } : {}),
          }
        : {}),
      goal: "Consolidate the shared information at the retained passage, merging every distinct detail and source association; preserve necessary local context and a destination reference when moving facts between pages.",
    });
  }
}
export async function analyzeConflict(ctx: FindingContext) {
  const selected = await localize(
    ctx,
    "conflict",
    "contains a claim involved in the apparent incompatibility or temporal/scope ambiguity signaled between passages in these pages",
  );
  const { snapshot, pages, dependencies, depend, ask, add } = ctx;
  for (const pair of await pairTargets(ctx, selected, "conflict")) {
    let preparation = await preparePair(ctx, "conflict", pair);
    if (!preparation) continue;
    const target = pair.target;
    let evidencePages = pages;
    if (
      preparation.resolution?.type === "choice" &&
      ["insufficient", "none"].includes(preparation.resolution.choice)
    ) {
      const sources = referencedPages(snapshot, pages);
      depend(sources);
      for (const ref of explicitReferences(pages))
        if (
          !snapshot.pages.some((page) => page.id === ref || page.slug === ref)
        )
          dependencies.push({ pageId: ref, fingerprint: null });
      if (sources.length) {
        evidencePages = [...pages, ...sources];
        preparation = await ask(
          { pages: evidencePages.map(evidencePage), target },
          preparationQuestions("conflict"),
        );
      }
    }
    const base = findingBase(ctx, target, evidencePages);
    const resolution = analystGates.certainChoice(preparation.resolution);
    const supported =
      resolution === "a" ||
      resolution === "b" ||
      resolution === "temporal" ||
      resolution === "scope";
    add({
      ...base,
      kind: "reconcile",
      status: supported ? "supported" : "uncertain",
      ...(supported ? { resolution } : {}),
      goal: "Apply only the evidence-established correction or clarification of factual periods/scopes; preserve all unrelated facts and source associations.",
    });
  }
}
export async function analyzeResidue(ctx: FindingContext) {
  const selected = await localize(
    ctx,
    "residue",
    "contains consolidator activity-only text or agent-added human follow-up, rather than an original user request",
  );
  for (const unit of selected) {
    const target = [unit];
    const preparation = await ctx.ask(
      { pages: ctx.pages.map(evidencePage), target },
      preparationQuestions("residue"),
    );
    const base = findingBase(ctx, target, ctx.pages);
    const { add } = ctx;
    add({
      ...base,
      kind: "remove_maintenance_residue",
      status: analystGates.yes(preparation.removable)
        ? "supported"
        : "uncertain",
      goal: "Remove the identified maintenance-only passage without losing subject knowledge or original requests.",
    });
  }
}
