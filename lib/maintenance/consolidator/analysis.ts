import { type BrainPage, isLinkType } from "../../brain/types";
import { fingerprint } from "../../canonical-json";
import { batchQuestions } from "./batching";
import { analystGates, SCREENING_THRESHOLD } from "./decision-policy";
import {
  analyzeConflict,
  analyzeDuplicate,
  analyzeResidue,
  type FindingContext,
} from "./finding-analysis";
import { validateEvaluation } from "./jev";
import { evidencePage } from "./projections";
import {
  choiceQuestion,
  RELATION_MEANINGS,
  screeningQuestions,
} from "./questions";
import { pageEvidenceFingerprint } from "./snapshot";
import type {
  AnalysisResult,
  AnalysisTask,
  Answer,
  Evaluate,
  Finding,
  Json,
  Question,
  Snapshot,
} from "./types";

class IncompleteAnalysis extends Error {}
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
  // Supply the full content once as ordered passages, with page metadata for context.
  const passageState = {
    pages: pages.map((page) => {
      const { markdown: _, ...metadata } = evidencePage(page);
      return metadata;
    }),
    units: units.map(({ context: _, ...unit }) => unit),
  };
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
      throw new IncompleteAnalysis();
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
  try {
    const screening = await ask(
      state,
      screeningQuestions(task.kind === "pair"),
    );
    const flagged = (id: string) =>
      screening[id]?.type === "boolean" &&
      screening[id].probability >= SCREENING_THRESHOLD;
    const ctx: FindingContext = {
      snapshot,
      task,
      pages,
      units,
      passageState,
      dependencies,
      ask,
      add,
      depend,
    };
    const handlers = {
      duplicate: analyzeDuplicate,
      conflict: analyzeConflict,
      residue: analyzeResidue,
    };
    for (const [kind, analyze] of Object.entries(handlers))
      if (flagged(kind)) await analyze(ctx);
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
            {
              none: "No supported missing relationship.",
              ...RELATION_MEANINGS,
            },
          ),
        },
      );
      const relation = analystGates.certainChoice(answers.relation);
      if (
        !relation ||
        !isLinkType(relation) ||
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
          type: relation,
        },
        goal: `Add the documented ${relation} relationship from source to target.`,
      });
    }
  } catch (error) {
    if (!(error instanceof IncompleteAnalysis)) throw error;
  }
  result.findings = [
    ...new Map(
      result.findings.map((finding) => [finding.id, finding]),
    ).values(),
  ];
  return result;
}
