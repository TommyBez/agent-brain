import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

// Local, post-run analysis only. Do not import providers or the experiment runner.
export const CRITERIA = [
  "supported_by_evidence",
  "preserves_distinct_information",
  "no_new_human_action",
  "meaningful_improvement",
] as const;
type Criterion = (typeof CRITERIA)[number];
type Label = "pass" | "fail" | "uncertain";
type Vector = Record<Criterion, number>;
const score = z.number().min(0).max(1);
const vectorSchema = z.object({
  supported_by_evidence: score,
  preserves_distinct_information: score,
  no_new_human_action: score,
  meaningful_improvement: score,
});
const judgment = z.object({
  verdict: z.enum(["pass", "fail", "uncertain"]),
  rationale: z.string().min(1),
});
const reviewSchema = z.object({
  candidateId: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  familyId: z.string().min(1),
  criteria: z.object({
    supported_by_evidence: judgment,
    preserves_distinct_information: judgment,
    no_new_human_action: judgment,
    meaningful_improvement: judgment,
  }),
});
const evaluationSchema = z.object({
  allowed: z.boolean(),
  answers: vectorSchema,
  usage: z.object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    gateway: z.record(z.string(), z.number().nonnegative()).optional(),
  }),
});
const passSchema = z.object({
  pass: z.number().int().positive(),
  status: z.literal("completed"),
  proposed: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  validationRejected: z.number().int().nonnegative(),
  schemaRejected: z.number().int().nonnegative(),
  generationFault: z.string().nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  reviewHash: z.string().nullable(),
  requestHash: z.string(),
  generationHash: z.string(),
  evaluationsHash: z.string(),
  reviewFrozenAt: z.string(),
  decisions: z.array(
    z.object({
      candidateId: z.string(),
      inputHash: z.string(),
      assistant: reviewSchema,
      assistantWouldPass: z.boolean(),
      jev: evaluationSchema,
      accepted: z.boolean(),
    }),
  ),
});
type PassReceipt = z.infer<typeof passSchema>;
export type PairedCase = {
  pass: number;
  candidateId: string;
  inputHash: string;
  familyId: string;
  criteria: z.infer<typeof reviewSchema>["criteria"];
  scores: Vector;
};
type Point = { label: Label; probability: number };

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function hash(value: unknown) {
  return hashText(JSON.stringify(value));
}
export function familyPartition(familyId: string) {
  return Number.parseInt(
    hashText(`jev-paired-v1:${familyId}`).slice(0, 8),
    16,
  ) %
    3 ===
    0
    ? "heldout"
    : "exploratory";
}
export function overallLabel(item: Pick<PairedCase, "criteria">): Label {
  const labels = CRITERIA.map((criterion) => item.criteria[criterion].verdict);
  if (labels.some((label) => label === "fail")) return "fail";
  return labels.every((label) => label === "pass") ? "pass" : "uncertain";
}
export function confusion(items: Array<{ label: Label; approved: boolean }>) {
  const result = {
    passApproved: 0,
    passRejected: 0,
    failApproved: 0,
    failRejected: 0,
    uncertainApproved: 0,
    uncertainRejected: 0,
  };
  for (const item of items) {
    const key =
      `${item.label}${item.approved ? "Approved" : "Rejected"}` as keyof typeof result;
    result[key]++;
  }
  return {
    ...result,
    decidedAgreement: result.passApproved + result.failRejected,
    decidedDisagreement: result.passRejected + result.failApproved,
    uncertain: result.uncertainApproved + result.uncertainRejected,
    compared: items.length,
  };
}
export function selectThreshold(points: Point[]) {
  const labeled = points.filter((point) => point.label !== "uncertain");
  const positives = labeled.filter((point) => point.label === "pass").length;
  const negatives = labeled.filter((point) => point.label === "fail").length;
  const evidence = {
    positives,
    negatives,
    uncertainExcluded: points.length - labeled.length,
  };
  if (!positives || !negatives)
    return {
      status: "unsupported" as const,
      reason: "both_label_classes_required",
      ...evidence,
    };
  const grid = Array.from({ length: 101 }, (_, index) => {
    const threshold = index / 100;
    return {
      threshold,
      ...confusion(
        labeled.map((point) => ({
          label: point.label,
          approved: point.probability >= threshold,
        })),
      ),
    };
  });
  const candidates = grid
    .filter((item) => item.failApproved === 0 && item.passApproved > 0)
    .sort(
      (a, b) => b.passApproved - a.passApproved || b.threshold - a.threshold,
    );
  if (!candidates.length)
    return {
      status: "unsupported" as const,
      reason: "no_threshold_accepts_a_positive_without_a_negative",
      ...evidence,
    };
  return {
    status: "exploratory_candidate" as const,
    ...evidence,
    selected: candidates[0],
    grid,
  };
}
function approves(item: PairedCase, thresholds: Vector) {
  return CRITERIA.every(
    (criterion) => item.scores[criterion] >= thresholds[criterion],
  );
}
export function compareVector(cases: PairedCase[], thresholds: Vector) {
  return confusion(
    cases.map((item) => ({
      label: overallLabel(item),
      approved: approves(item, thresholds),
    })),
  );
}
function compareCriterion(
  cases: PairedCase[],
  criterion: Criterion,
  threshold: number,
) {
  return confusion(
    cases.map((item) => ({
      label: item.criteria[criterion].verdict,
      approved: item.scores[criterion] >= threshold,
    })),
  );
}

export function scoreDistributions(points: Point[]) {
  return Object.fromEntries(
    (["pass", "fail", "uncertain"] as const).map((label) => {
      const values = points
        .filter((point) => point.label === label)
        .map((point) => point.probability)
        .sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return [
        label,
        {
          count: values.length,
          min: values[0] ?? null,
          median:
            values.length === 0
              ? null
              : values.length % 2 === 0
                ? (values[middle - 1] + values[middle]) / 2
                : values[middle],
          max: values[values.length - 1] ?? null,
        },
      ];
    }),
  ) as Record<
    Label,
    {
      count: number;
      min: number | null;
      median: number | null;
      max: number | null;
    }
  >;
}

function criterionDistributions(cases: PairedCase[]) {
  return Object.fromEntries(
    CRITERIA.map((criterion) => [
      criterion,
      scoreDistributions(
        cases.map((item) => ({
          label: item.criteria[criterion].verdict,
          probability: item.scores[criterion],
        })),
      ),
    ]),
  ) as Record<Criterion, ReturnType<typeof scoreDistributions>>;
}

export function analyzeCases(cases: PairedCase[], thresholds: Vector) {
  const exploratory = cases.filter(
    (item) => familyPartition(item.familyId) === "exploratory",
  );
  const heldout = cases.filter(
    (item) => familyPartition(item.familyId) === "heldout",
  );
  const perCriterion = Object.fromEntries(
    CRITERIA.map((criterion) => [
      criterion,
      compareCriterion(cases, criterion, thresholds[criterion]),
    ]),
  ) as Record<Criterion, ReturnType<typeof confusion>>;
  // Threshold selection sees exploratory cases only. Heldout labels are evaluated afterwards.
  const calibration = Object.fromEntries(
    CRITERIA.map((criterion) => [
      criterion,
      selectThreshold(
        exploratory.map((item) => ({
          label: item.criteria[criterion].verdict,
          probability: item.scores[criterion],
        })),
      ),
    ]),
  ) as Record<Criterion, ReturnType<typeof selectThreshold>>;
  const candidateVector = CRITERIA.every(
    (criterion) => calibration[criterion].status === "exploratory_candidate",
  )
    ? (Object.fromEntries(
        CRITERIA.map((criterion) => [
          criterion,
          calibration[criterion].status === "exploratory_candidate"
            ? calibration[criterion].selected.threshold
            : undefined,
        ]),
      ) as Vector)
    : null;
  const holdoutByCriterion = candidateVector
    ? (Object.fromEntries(
        CRITERIA.map((criterion) => [
          criterion,
          compareCriterion(heldout, criterion, candidateVector[criterion]),
        ]),
      ) as Record<Criterion, ReturnType<typeof confusion>>)
    : null;
  const holdoutOverall = candidateVector
    ? compareVector(heldout, candidateVector)
    : null;
  const safetyFailures =
    holdoutByCriterion &&
    CRITERIA.filter(
      (criterion) => holdoutByCriterion[criterion].failApproved > 0,
    );
  const missingHoldoutClasses =
    holdoutByCriterion &&
    CRITERIA.filter((criterion) => {
      const counts = holdoutByCriterion[criterion];
      return (
        counts.passApproved + counts.passRejected === 0 ||
        counts.failApproved + counts.failRejected === 0
      );
    });
  const families = [...new Set(cases.map((item) => item.familyId))]
    .sort()
    .map((familyId) => {
      const members = cases.filter((item) => item.familyId === familyId);
      return {
        familyId,
        partition: familyPartition(familyId),
        proposals: members.length,
        passes: [...new Set(members.map((item) => item.pass))],
        uniqueInputs: new Set(members.map((item) => item.inputHash)).size,
        labelPatterns: [
          ...new Set(
            members.map((item) =>
              CRITERIA.map(
                (criterion) => item.criteria[criterion].verdict,
              ).join("/"),
            ),
          ),
        ],
        fixedThresholdComparison: compareVector(members, thresholds),
        scoreDistributions: criterionDistributions(members),
      };
    });
  const vectors: Vector[] = [
    thresholds,
    {
      supported_by_evidence: 0.9,
      preserves_distinct_information: 0.8,
      no_new_human_action: 0.9,
      meaningful_improvement: 0.7,
    },
    {
      supported_by_evidence: 0.85,
      preserves_distinct_information: 0.7,
      no_new_human_action: 0.9,
      meaningful_improvement: 0.6,
    },
    {
      supported_by_evidence: 0.8,
      preserves_distinct_information: 0.6,
      no_new_human_action: 0.9,
      meaningful_improvement: 0.5,
    },
  ];
  return {
    comparedProposals: cases.length,
    assistantWouldApprove: cases.filter((item) => overallLabel(item) === "pass")
      .length,
    jevWouldApprove: cases.filter((item) => approves(item, thresholds)).length,
    fixedThresholds: thresholds,
    perCriterion,
    scoreDistributions: criterionDistributions(cases),
    overall: compareVector(cases, thresholds),
    families,
    dependence: {
      distinctFamilies: families.length,
      repeatedInputs:
        cases.length - new Set(cases.map((item) => item.inputHash)).size,
      largestFamilyProposals: Math.max(
        0,
        ...families.map((item) => item.proposals),
      ),
      exploratoryFamilies: families.filter(
        (item) => item.partition === "exploratory",
      ).length,
      heldoutFamilies: families.filter((item) => item.partition === "heldout")
        .length,
      exploratoryProposals: exploratory.length,
      heldoutProposals: heldout.length,
      warning:
        "Repeated passes and related proposals are correlated; proposal count is not an independent sample size.",
    },
    calibration: {
      byCriterion: calibration,
      candidateVector,
      heldout: candidateVector
        ? {
            perCriterion: holdoutByCriterion,
            overall: holdoutOverall,
            safetyFailures,
            missingLabelClasses: missingHoldoutClasses,
          }
        : null,
      status: !candidateVector
        ? "unsupported_incomplete_exploratory_evidence"
        : safetyFailures?.length
          ? "unsafe_on_heldout"
          : missingHoldoutClasses?.length
            ? "unsupported_missing_heldout_classes"
            : "exploratory_only",
      promoted: false,
      note: "No thresholds are changed. Even zero observed heldout errors on this small correlated corpus are not a safety guarantee.",
    },
    sensitivity: vectors.map((vector, index) => ({
      name: index === 0 ? "baseline" : `descriptive-${index}`,
      thresholds: vector,
      comparison: compareVector(cases, vector),
      recommended: false,
    })),
    pairedJudgments: cases.map((item) => ({
      ...item,
      partition: familyPartition(item.familyId),
      assistantOverall: overallLabel(item),
      jevOverall: approves(item, thresholds),
      criterionDecisions: Object.fromEntries(
        CRITERIA.map((criterion) => [
          criterion,
          item.scores[criterion] >= thresholds[criterion],
        ]),
      ),
    })),
  };
}

async function jsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function verifyReceipt(directory: string, receipt: PassReceipt) {
  const file = (name: string) =>
    resolve(directory, `${name}-${String(receipt.pass).padStart(2, "0")}.json`);
  const generation = await jsonFile(file("generation"));
  const request = await jsonFile(file("blind-request"));
  const frozen = await jsonFile(file("review-frozen"));
  if (
    hash(generation) !== receipt.generationHash ||
    hash(request) !== receipt.requestHash ||
    frozen.requestHash !== receipt.requestHash ||
    frozen.reviewHash !== receipt.reviewHash ||
    frozen.frozenAt !== receipt.reviewFrozenAt
  )
    throw new Error(`Receipt integrity failed in pass ${receipt.pass}.`);
  if (receipt.decisions.length === 0) {
    if (request.candidates.length !== 0 || receipt.evaluationsHash !== hash({}))
      throw new Error("Empty pass has unexpected candidates/evaluations.");
    return;
  }
  const reviewText = await readFile(file("assistant-review"), "utf8");
  if (hashText(reviewText) !== receipt.reviewHash)
    throw new Error("Frozen assistant review changed.");
  const review = JSON.parse(reviewText);
  const evaluations = await jsonFile(file("jev-evaluations"));
  if (
    hash(evaluations) !== receipt.evaluationsHash ||
    Object.keys(evaluations).length !== receipt.decisions.length ||
    review.candidates.length !== receipt.decisions.length ||
    request.candidates.length !== receipt.decisions.length
  )
    throw new Error(
      "Paired candidates/evaluations do not match their receipt.",
    );
  for (const decision of receipt.decisions) {
    const reviewed = review.candidates.find(
      (item: { candidateId: string }) =>
        item.candidateId === decision.candidateId,
    );
    const candidate = request.candidates.find(
      (item: { candidateId: string }) =>
        item.candidateId === decision.candidateId,
    );
    const evaluation = evaluations[decision.candidateId];
    if (
      !reviewed ||
      !candidate ||
      !evaluation ||
      hash(reviewSchema.parse(reviewed)) !== hash(decision.assistant) ||
      hash(candidate.input) !== decision.inputHash ||
      candidate.inputHash !== decision.inputHash ||
      decision.assistant.inputHash !== decision.inputHash ||
      evaluation.inputHash !== decision.inputHash ||
      evaluation.reviewHash !== receipt.reviewHash ||
      hash(evaluationSchema.parse(evaluation.result)) !== hash(decision.jev)
    )
      throw new Error("A candidate, review or evaluation hash does not match.");
    const frozenAt = Date.parse(receipt.reviewFrozenAt);
    const evaluatedAt = Date.parse(evaluation.evaluatedAt);
    if (
      !Number.isFinite(frozenAt) ||
      !Number.isFinite(evaluatedAt) ||
      evaluatedAt < frozenAt
    )
      throw new Error("Jev evaluation predates the frozen assistant review.");
  }
}

const TITLES: Record<Criterion, string> = {
  supported_by_evidence: "Supporto delle fonti",
  preserves_distinct_information: "Conservazione delle informazioni",
  no_new_human_action: "Nessuna nuova azione umana",
  meaningful_improvement: "Miglioramento concreto",
};
function matrixRow(title: string, counts: ReturnType<typeof confusion>) {
  return `| ${title} | ${counts.passApproved} | ${counts.passRejected} | ${counts.failApproved} | ${counts.failRejected} | ${counts.uncertainApproved} | ${counts.uncertainRejected} |`;
}

export async function analyzeDirectory(directory: string) {
  const specText = await readFile(
    resolve(directory, "evaluation-spec.json"),
    "utf8",
  );
  const spec = z
    .object({
      passes: z.number().int().positive(),
      generator: z.string(),
      thresholds: vectorSchema,
    })
    .parse(JSON.parse(specText));
  // This guard deliberately precedes reads of any new Jev scores.
  const summary = await jsonFile(resolve(directory, "summary.json"));
  if (summary.status !== "completed" || summary.passes !== spec.passes)
    throw new Error(
      "Analysis requires the complete frozen experiment; do not unblind an active run.",
    );
  const protocol = await jsonFile(resolve(directory, "protocol.json"));
  if (
    protocol.evaluationSpecHash !== hashText(specText) ||
    hash(vectorSchema.parse(protocol.thresholds)) !== hash(spec.thresholds)
  )
    throw new Error("Frozen protocol does not match the analysis spec.");
  const receipts: PassReceipt[] = [];
  for (let pass = 1; pass <= spec.passes; pass++) {
    const receipt = passSchema.parse(
      await jsonFile(
        resolve(directory, `pass-${String(pass).padStart(2, "0")}.json`),
      ),
    );
    if (receipt.pass !== pass) throw new Error("Unexpected pass receipt.");
    await verifyReceipt(directory, receipt);
    receipts.push(receipt);
  }
  const cases = receipts.flatMap((receipt) =>
    receipt.decisions.map((decision): PairedCase => {
      const item = {
        pass: receipt.pass,
        candidateId: decision.candidateId,
        inputHash: decision.inputHash,
        familyId: decision.assistant.familyId,
        criteria: decision.assistant.criteria,
        scores: decision.jev.answers,
      };
      if (
        decision.assistant.candidateId !== decision.candidateId ||
        decision.assistantWouldPass !== (overallLabel(item) === "pass") ||
        decision.accepted !== approves(item, spec.thresholds) ||
        decision.jev.allowed !== decision.accepted
      )
        throw new Error(
          "Stored gate decisions disagree with frozen labels or thresholds.",
        );
      return item;
    }),
  );
  if (new Set(cases.map((item) => item.candidateId)).size !== cases.length)
    throw new Error("Duplicate candidate identity.");
  const inputTokens = receipts.reduce(
    (sum, item) => sum + item.usage.inputTokens,
    0,
  );
  const outputTokens = receipts.reduce(
    (sum, item) => sum + item.usage.outputTokens,
    0,
  );
  const evaluations = receipts.flatMap((item) =>
    item.decisions.map((decision) => decision.jev),
  );
  const priced = evaluations.filter(
    (item) => item.usage.gateway?.cost !== undefined,
  );
  const result = {
    schemaVersion: 1,
    source: directory,
    evaluationSpecHash: hashText(specText),
    passes: receipts.length,
    proposed: receipts.reduce((sum, item) => sum + item.proposed, 0),
    validationRejected: receipts.reduce(
      (sum, item) => sum + item.validationRejected,
      0,
    ),
    schemaRejected: receipts.reduce(
      (sum, item) => sum + item.schemaRejected,
      0,
    ),
    generationFaults: receipts
      .filter((item) => item.generationFault)
      .map((item) => ({ pass: item.pass, fault: item.generationFault })),
    interpretation:
      "Assistant labels are an independent reference judgment, not user ground truth or proof of actual quality. Decisions are counterfactual on Jev's observed trajectory; alternative gates would change subsequent proposals.",
    ...analyzeCases(cases, spec.thresholds),
    costs: {
      jev: {
        calls: evaluations.length,
        recordedUsd: priced.reduce(
          (sum, item) => sum + (item.usage.gateway?.cost ?? 0),
          0,
        ),
        receiptsWithCost: priced.length,
        missingCostReceipts: evaluations.length - priced.length,
        inputTokens: evaluations.reduce(
          (sum, item) => sum + (item.usage.inputTokens ?? 0),
          0,
        ),
        outputTokens: evaluations.reduce(
          (sum, item) => sum + (item.usage.outputTokens ?? 0),
          0,
        ),
      },
      generator: {
        model: spec.generator,
        inputTokens,
        outputTokens,
        estimatedUsd:
          spec.generator === "deepseek/deepseek-v4.1-flash"
            ? inputTokens * 0.0000003 + outputTokens * 0.0000012
            : null,
        inputUsdPerMillion: 0.3,
        outputUsdPerMillion: 1.2,
        caveat:
          "Estimate using Gateway list prices observed on 2026-09-17; cache discounts/provider variation/retries and previous trials are excluded.",
      },
    },
  };
  const lines = [
    "# Confronto cieco assistente–Jev",
    "",
    `${result.passes} passaggi, ${result.comparedProposals} proposte valutate da entrambi, ${result.dependence.distinctFamilies} famiglie. L'assistente avrebbe approvato ${result.assistantWouldApprove} proposte; Jev ne ha approvate ${result.jevWouldApprove}.`,
    "",
    "I giudizi dell'assistente sono un riferimento indipendente, non la verità oggettiva. I punteggi Jev sono stati letti dopo il completamento delle review; hash e ordine temporale sono verificati. Solo Jev ha determinato la traiettoria. Le alternative sono valutazioni controfattuali delle proposte osservate, non nuovi run.",
    "",
    "## Confronto con le soglie originali",
    "",
    "Pass/fail/incerto si riferiscono all'assistente; approvata/respinta si riferiscono a Jev. Un incerto non viene trasformato in un negativo noto. La decisione complessiva dell'assistente approva solo quattro pass.",
    "",
    "| Criterio | Pass approvato | Pass respinto | Fail approvato | Fail respinto | Incerto approvato | Incerto respinto |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...CRITERIA.map((criterion) =>
      matrixRow(TITLES[criterion], result.perCriterion[criterion]),
    ),
    matrixRow("Complessivo", result.overall),
    "",
    "## Punteggi Jev per giudizio dell'assistente",
    "",
    "Distribuzioni descrittive separate per etichetta, calcolate sulle proposte osservate senza assumere indipendenza. Celle vuote indicano assenza di esempi, non punteggio zero. Le stesse distribuzioni per famiglia sono in analysis.json.",
    "",
    "| Criterio | Giudizio assistente | Numero | Minimo | Mediana | Massimo |",
    "|---|---|---:|---:|---:|---:|",
    ...CRITERIA.flatMap((criterion) =>
      (["pass", "fail", "uncertain"] as const).map((label) => {
        const stats = result.scoreDistributions[criterion][label];
        const display = (value: number | null) =>
          value === null ? "—" : value.toFixed(3);
        return `| ${TITLES[criterion]} | ${label} | ${stats.count} | ${display(stats.min)} | ${display(stats.median)} | ${display(stats.max)} |`;
      }),
    ),
    "",
    "## Dipendenza tra proposte",
    "",
    `${result.dependence.exploratoryFamilies} famiglie esplorative (${result.dependence.exploratoryProposals} proposte); ${result.dependence.heldoutFamilies} famiglie tenute da parte (${result.dependence.heldoutProposals} proposte). Input identici ripetuti: ${result.dependence.repeatedInputs}. La famiglia maggiore contiene ${result.dependence.largestFamilyProposals} proposte. I conteggi non rappresentano osservazioni indipendenti.`,
    "",
    "| Famiglia | Gruppo | Proposte | Input distinti | Passaggi |",
    "|---|---|---:|---:|---|",
    ...result.families.map(
      (family) =>
        `| ${family.familyId.replaceAll("|", "\\|")} | ${family.partition} | ${family.proposals} | ${family.uniqueInputs} | ${family.passes.join(", ")} |`,
    ),
    "",
    "## Esplorazione delle soglie",
    "",
    "Griglia 0,00–1,00 a passi di 0,01, solo sul gruppo esplorativo e solo etichette pass/fail. Sono richieste entrambe le classi: zero fail approvati, massimo numero di pass approvati, poi soglia più alta. Nessuna modifica automatica.",
    "",
    ...CRITERIA.map((criterion) => {
      const item = result.calibration.byCriterion[criterion];
      return `- ${TITLES[criterion]}: ${item.status === "exploratory_candidate" ? `soglia candidata ${item.selected.threshold.toFixed(2)}` : `non supportata (${item.reason})`}; ${item.positives} pass, ${item.negatives} fail, ${item.uncertainExcluded} incerti esclusi.`;
    }),
    "",
    `Esito: **${result.calibration.status}**. Nessun vettore promosso. ${result.calibration.heldout ? `Il vettore candidato è stato applicato una volta ai dati tenuti da parte; fail approvati complessivi: ${result.calibration.heldout.overall?.failApproved}; incerti approvati: ${result.calibration.heldout.overall?.uncertainApproved}.` : "Non esiste un vettore completo supportato dai dati esplorativi: nessuna verifica di un nuovo vettore sul gruppo tenuto da parte."}`,
    "",
    "## Sensibilità descrittiva",
    "",
    "Ordine soglie: fonti / conservazione / azioni umane / utilità. Questi vettori prefissati non sono raccomandazioni. Cambiare soglia può cambiare la traiettoria successiva, che questa tabella non simula.",
    "",
    "| Soglie | Approvate | Di cui assistente pass | Di cui assistente fail | Di cui assistente incerto |",
    "|---|---:|---:|---:|---:|",
    ...result.sensitivity.map((item) => {
      const counts = item.comparison;
      return `| ${CRITERIA.map((criterion) => item.thresholds[criterion].toFixed(2)).join(" / ")} | ${counts.passApproved + counts.failApproved + counts.uncertainApproved} | ${counts.passApproved} | ${counts.failApproved} | ${counts.uncertainApproved} |`;
    }),
    "",
    "## Costi e limiti",
    "",
    `Jev: $${result.costs.jev.recordedUsd.toFixed(6)} registrati su ${result.costs.jev.receiptsWithCost}/${result.costs.jev.calls} ricevute. Generatore: ${result.costs.generator.estimatedUsd === null ? "stima non disponibile" : `$${result.costs.generator.estimatedUsd.toFixed(6)} stimati`} (${inputTokens} token in ingresso, ${outputTokens} in uscita). La stima usa prezzi di listino $0,30/$1,20 per milione e non include sconti cache o differenze del provider. Run precedenti e tentativi senza ricevuta di costo sono esclusi.`,
    "",
    `Errori di generazione: ${result.generationFaults.length}; proposte fuori schema: ${result.schemaRejected}; respinte dalla validazione: ${result.validationRejected}. Questi casi non sono giudizi di qualità di Jev.`,
    "",
    "Il campione ha quattro pagine, una singola traiettoria e proposte correlate. Poche famiglie o assenza di negativi impediscono una calibrazione affidabile. Nessuna stima di sicurezza generale, nessun intervallo di confidenza basato su indipendenza. Le motivazioni e tutti i confronti sono in analysis.json.",
    "",
  ];
  for (const [name, contents] of [
    ["analysis.json", `${JSON.stringify(result, null, 2)}\n`],
    ["analysis.md", lines.join("\n")],
  ]) {
    const path = resolve(directory, name);
    await writeFile(`${path}.tmp`, contents, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: "string" } } });
  if (!values.input)
    throw new Error(
      "Supply --input with the completed paired experiment directory.",
    );
  const result = await analyzeDirectory(resolve(values.input));
  console.log(
    JSON.stringify({
      passes: result.passes,
      comparedProposals: result.comparedProposals,
      families: result.dependence.distinctFamilies,
      assistantWouldApprove: result.assistantWouldApprove,
      jevWouldApprove: result.jevWouldApprove,
      calibration: result.calibration.status,
      reports: ["analysis.json", "analysis.md"],
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    resolve("scripts/analyze-consolidation-paired.ts")
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Analysis failed.");
    process.exitCode = 1;
  });
}
