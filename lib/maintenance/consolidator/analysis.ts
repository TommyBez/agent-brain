import type { BrainPage, LinkType } from "../../brain/types";
import { batchQuestions } from "./batching";
import { analystGates, SCREENING_THRESHOLD } from "./decision-policy";
import { validateEvaluation } from "./jev";
import {
  booleanQuestion,
  choiceQuestion,
  preparationQuestions,
  RELATION_MEANINGS,
  screeningQuestions,
} from "./questions";
import { evidencePage, fingerprint, pageEvidenceFingerprint } from "./snapshot";
import type {
  AnalysisResult,
  AnalysisTask,
  Answer,
  Evaluate,
  EvidenceUnit,
  Finding,
  Json,
  Question,
  Snapshot,
} from "./types";

/** Resolve only explicit references to existing Brain pages; never search the corpus with Jev. */
export function referencedPages(
  snapshot: Snapshot,
  pages: BrainPage[],
): BrainPage[] {
  const references = new Set(
    pages.flatMap((page) => [
      ...page.links
        .filter(
          (link) => link.type === "references" || link.type === "decided_in",
        )
        .map((link) => link.targetId),
      ...[...page.markdown.matchAll(/\/pages\/([\w/-]+)/g)].map(
        (match) => match[1],
      ),
    ]),
  );
  return snapshot.pages.filter(
    (page) =>
      !pages.some((source) => source.id === page.id) &&
      (references.has(page.id) || references.has(page.slug)),
  );
}

/** Screen full pages first. Paragraphs exist only as addresses for a concrete intervention. */
export async function analyzeTask(
  snapshot: Snapshot,
  task: AnalysisTask,
  evaluate: Evaluate,
): Promise<AnalysisResult> {
  const pages = task.pageIds.map((id) => {
    const page = snapshot.pages.find((page) => page.id === id);
    if (!page) throw new Error("Analysis page is missing from the snapshot");
    return page;
  });
  const units = snapshot.units.filter(
    (unit) => task.pageIds.includes(unit.pageId) && unit.text.trim(),
  );
  const dependencies: NonNullable<AnalysisResult["dependencies"]> = [];
  const result: AnalysisResult = {
    taskId: task.id,
    status: "complete",
    findings: [],
    judgments: [],
    dependencies,
  };
  const state = { pages: pages.map(evidencePage) };
  const depend = (sources: BrainPage[]) => {
    for (const page of sources)
      if (!dependencies.some((ref) => ref.pageId === page.id))
        dependencies.push({
          pageId: page.id,
          fingerprint: pageEvidenceFingerprint(page),
        });
  };
  depend(pages);
  const ask = async (
    state: unknown,
    questions: Record<string, Question>,
  ): Promise<Record<string, Answer>> => {
    const json = state as Json;
    const { batches, oversized } = batchQuestions(json, questions);
    if (oversized.length) {
      result.status = "incomplete";
      result.errors = [
        { questionIds: oversized, reason: "evaluation_input_exceeds_policy" },
      ];
      return {};
    }
    const answers: Record<string, Answer> = {};
    for (const questions of batches) {
      const request = { state: json, questions };
      const response = validateEvaluation(request, await evaluate(request));
      result.judgments.push({ ...request, ...response });
      Object.assign(answers, response.answers);
    }
    return answers;
  };
  const add = (finding: Omit<Finding, "id">) =>
    result.findings.push({ ...finding, id: fingerprint(finding) });
  const screening = await ask(state, screeningQuestions(task.kind === "pair"));
  if (result.errors?.length) return result;
  const flagged = (id: string) =>
    screening[id]?.type === "boolean" &&
    screening[id].probability >= SCREENING_THRESHOLD;

  for (const kind of ["duplicate", "conflict", "residue"] as const) {
    if (!flagged(kind)) continue;
    const instruction = {
      duplicate:
        "contains factual information substantially repeated by another passage in the supplied page or opposite page of this pair",
      conflict:
        "contains a claim involved in the apparent incompatibility or temporal/scope ambiguity signaled between passages in these pages",
      residue:
        "contains consolidator activity-only text or agent-added human follow-up, rather than an original user request",
    }[kind];
    // Linear localization, only after a positive whole-page signal.
    const localization = await ask(
      { ...state, units },
      Object.fromEntries(
        units.map((_, i) => [
          `passage_${i}`,
          booleanQuestion(
            `Select whether units[${i}] ${instruction}. Use its complete page context. This question identifies an edit target, not permission to remove it.`,
          ),
        ]),
      ),
    );
    if (result.errors?.length) return result;
    const selected = units.filter((_, i) => {
      const answer = localization[`passage_${i}`];
      return (
        answer?.type === "boolean" && answer.probability >= SCREENING_THRESHOLD
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
      continue;
    }
    const pairs: EvidenceUnit[][] = [];
    const seen = new Set<string>();
    if (kind === "residue") pairs.push(...selected.map((unit) => [unit]));
    else
      for (const anchor of selected) {
        const candidates = selected.filter(
          (unit) =>
            unit.id !== anchor.id &&
            (task.kind === "document" || unit.pageId !== anchor.pageId),
        );
        // Choice accepts at most 255 options, including none. Every option is visited.
        for (let start = 0; start < candidates.length; start += 254) {
          const options = candidates.slice(start, start + 254);
          const answers = await ask(
            { ...state, anchor, candidates: options },
            {
              partner: choiceQuestion(
                `Which passage in candidates ${kind === "duplicate" ? "repeats factual information from anchor" : "makes a claim apparently incompatible with anchor about the same entity and scope"}? Identify the counterpart only; a supported correction or deletion is NOT required. Select none when no counterpart exists; shared topic alone is insufficient.`,
                Object.fromEntries([
                  ["none", "No suitable partner."],
                  ...options.map((unit, index) => [
                    `p${index}`,
                    `candidates[${index}] (passage ${unit.id})`,
                  ]),
                ]),
              ),
            },
          );
          if (result.errors?.length) return result;
          const choice =
            answers.partner?.type === "choice"
              ? answers.partner.choice
              : undefined;
          if (!choice || choice === "none") continue;
          const partner = options[Number(choice.slice(1))];
          const key = [anchor.id, partner.id].sort().join("|");
          if (!seen.has(key)) {
            pairs.push([anchor, partner]);
            seen.add(key);
          }
        }
      }
    for (const target of pairs) {
      let evidencePages = pages;
      let preparation = await ask(
        { pages: evidencePages.map(evidencePage), target },
        preparationQuestions(kind),
      );
      if (
        kind === "conflict" &&
        preparation.resolution?.type === "choice" &&
        ["insufficient", "none"].includes(preparation.resolution.choice)
      ) {
        const sources = referencedPages(snapshot, pages);
        depend(sources);
        const refs = new Set(
          pages.flatMap((page) => [
            ...page.links
              .filter(
                (link) =>
                  link.type === "references" || link.type === "decided_in",
              )
              .map((link) => link.targetId),
            ...[...page.markdown.matchAll(/\/pages\/([\w/-]+)/g)].map(
              (match) => match[1],
            ),
          ]),
        );
        for (const ref of refs)
          if (
            !snapshot.pages.some((page) => page.id === ref || page.slug === ref)
          )
            dependencies.push({ pageId: ref, fingerprint: null });
        if (sources.length) {
          evidencePages = [...pages, ...sources];
          preparation = await ask(
            { pages: evidencePages.map(evidencePage), target },
            preparationQuestions(kind),
          );
        }
      }
      if (result.errors?.length) return result;
      const base = {
        pageIds: task.pageIds,
        unitIds: target.map((unit) => unit.id),
        evidenceUnitIds: snapshot.units
          .filter((unit) =>
            evidencePages.some((page) => page.id === unit.pageId),
          )
          .map((unit) => unit.id),
      };
      if (kind === "residue") {
        add({
          ...base,
          kind: "remove_maintenance_residue",
          status: analystGates.yes(preparation.removable)
            ? "supported"
            : "uncertain",
          goal: "Remove the identified maintenance-only passage without losing subject knowledge or original requests.",
        });
      } else if (kind === "duplicate") {
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
      } else {
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
  }
  for (const [id, source, target] of [
    ["link_ab", pages[0], pages[1]],
    ["link_ba", pages[1], pages[0]],
  ] as const) {
    if (!flagged(id) || !target) continue;
    const answers = await ask(
      { source: evidencePage(source), target: evidencePage(target) },
      {
        relation: choiceQuestion(
          "Which exact useful directed relationship from source to target is established by their text and missing from source.links? Entities must be unambiguous; shared topic is insufficient. Select none if the matching relationship already exists.",
          { none: "No supported missing relationship.", ...RELATION_MEANINGS },
        ),
      },
    );
    const relation = analystGates.certainChoice(answers.relation);
    if (
      !relation ||
      relation === "none" ||
      source.links.some(
        (link) => link.targetId === target.id && link.type === relation,
      )
    )
      continue;
    add({
      kind: "add_link",
      status: "supported",
      pageIds: task.pageIds,
      unitIds: units.map((unit) => unit.id),
      evidenceUnitIds: units.map((unit) => unit.id),
      link: {
        sourceId: source.id,
        targetId: target.id,
        type: relation as LinkType,
      },
      goal: `Add the documented ${relation} relationship from source to target.`,
    });
  }
  result.findings = [
    ...new Map(
      result.findings.map((finding) => [finding.id, finding]),
    ).values(),
  ];
  return result;
}
