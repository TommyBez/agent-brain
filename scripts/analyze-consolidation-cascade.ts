import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CONSOLIDATION_CRITERIA,
  type ConsolidationCriterion,
} from "../lib/maintenance/consolidation-rubric";
import { JEV_CONSOLIDATION_THRESHOLDS } from "../lib/maintenance/jev";
import type { KimiEvaluation } from "../lib/maintenance/kimi-evaluator";
import {
  type CascadeReceipt,
  type CascadeVerdict,
  cascadeHash,
  hashCascadeText,
  runCascade,
} from "./evaluate-consolidation-cascade";

type Summary = Awaited<ReturnType<typeof runCascade>>;
type Case = Summary["byCase"][number];
type Reference = "pass" | "fail" | "uncertain";
type Decision = CascadeVerdict | "notEvaluated";
type Arm = "jevOnly" | "kimiOnly" | "cascade";
const arms: Arm[] = ["jevOnly", "kimiOnly", "cascade"];
const keys = CONSOLIDATION_CRITERIA;
const decisions: Decision[] = [
  "pass",
  "fail",
  "uncertain",
  "error",
  "notEvaluated",
];
const references: Reference[] = ["pass", "fail", "uncertain"];
const armNames: Record<Arm, string> = {
  jevOnly: "Jev originale",
  kimiOnly: "Kimi quattro criteri",
  cascade: "Jev → Kimi selettivo",
};
const criterionNames: Record<ConsolidationCriterion, string> = {
  supported_by_evidence: "Supporto nelle fonti",
  preserves_distinct_information: "Conservazione dell’informazione",
  no_new_human_action: "Nessuna nuova azione umana",
  meaningful_improvement: "Miglioramento concreto",
};
type Bands = {
  developmentCases?: number;
  observationsPerCase?: number;
  margin?: number;
  frozenAt?: string;
  criteria: Record<
    ConsolidationCriterion,
    { rejectBelow: number; acceptAtOrAbove: number }
  >;
};
type Observation = { reference: Reference; decision: Decision };
type IntentDiscrepancy = {
  caseId: string;
  familyId: string;
  variantId: string;
  intendedCriterion: ConsolidationCriterion | null;
  intended: "pass" | "fail";
  actualReference: Reference;
  rationale: Array<{
    criterion: ConsolidationCriterion;
    verdict: Reference;
    rationale: string;
  }>;
};

/** Uncertain predictions and technical errors are not recoded as factual rejection. */
export function cascadeConfusion(items: Observation[]) {
  const matrix = Object.fromEntries(
    references.map((reference) => [
      reference,
      Object.fromEntries(decisions.map((decision) => [decision, 0])),
    ]),
  ) as Record<Reference, Record<Decision, number>>;
  for (const item of items) {
    if (
      !references.includes(item.reference) ||
      !decisions.includes(item.decision)
    )
      throw new Error("Invalid analysis observation.");
    matrix[item.reference][item.decision]++;
  }
  const column = (decision: Decision) =>
    references.reduce((sum, reference) => sum + matrix[reference][decision], 0);
  const referenceCounts = Object.fromEntries(
    references.map((reference) => [
      reference,
      decisions.reduce((sum, decision) => sum + matrix[reference][decision], 0),
    ]),
  ) as Record<Reference, number>;
  const truePositive = matrix.pass.pass,
    falseNegative = matrix.pass.fail;
  const falsePositive = matrix.fail.pass,
    trueNegative = matrix.fail.fail;
  return {
    total: items.length,
    compared: items.length - column("notEvaluated"),
    matrix,
    referenceCounts,
    truePositive,
    falseNegative,
    falsePositive,
    trueNegative,
    uncertain: column("uncertain"),
    error: column("error"),
    notEvaluated: column("notEvaluated"),
    referenceUncertain: referenceCounts.uncertain,
    uncertainReferenceAccepted: matrix.uncertain.pass,
    positivesNotAccepted: {
      fail: falseNegative,
      uncertain: matrix.pass.uncertain,
      error: matrix.pass.error,
      notEvaluated: matrix.pass.notEvaluated,
    },
    decidedCompared:
      truePositive + falseNegative + falsePositive + trueNegative,
    decidedAgreement: truePositive + trueNegative,
    positiveAcceptance: {
      numerator: truePositive,
      denominator: referenceCounts.pass - matrix.pass.notEvaluated,
    },
    negativeAcceptance: {
      numerator: falsePositive,
      denominator: referenceCounts.fail - matrix.fail.notEvaluated,
    },
  };
}
export function cascadeCriterionDecision(
  item: Case,
  criterion: ConsolidationCriterion,
  arm: Arm,
): Decision {
  if (
    arm === "cascade" &&
    item.routing.state === "red" &&
    item.routing.bands[criterion] === "gray"
  )
    return "notEvaluated";
  return item.arms[arm].criteria[criterion];
}
function ref(value: CascadeVerdict): Reference {
  if (value === "error")
    throw new Error("Independent reference cannot be a technical error.");
  return value;
}
function kimi(receipt: CascadeReceipt | null) {
  return receipt?.outcome === "success" && receipt.kind !== "jev"
    ? (receipt.result as KimiEvaluation)
    : null;
}
const ratio = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : null;
function recoveries(cases: Case[]) {
  const valid = cases.filter((item) => item.reference === "pass");
  const recovered = valid.filter(
    (item) =>
      item.arms.jevOnly.verdict !== "pass" &&
      item.arms.cascade.verdict === "pass",
  );
  const lost = valid.filter(
    (item) =>
      item.arms.jevOnly.verdict === "pass" &&
      item.arms.cascade.verdict !== "pass",
  );
  return {
    referenceValid: valid.length,
    cases: recovered.map((item) => item.caseId),
    count: recovered.length,
    families: [...new Set(recovered.map((item) => item.familyId))],
    grayResolved: recovered
      .filter((item) => item.routing.state === "gray")
      .map((item) => item.caseId),
    changedBandOnly: recovered
      .filter((item) => item.routing.state === "green")
      .map((item) => item.caseId),
    previouslyAcceptedNowBlocked: lost.map((item) => ({
      caseId: item.caseId,
      decision: item.arms.cascade.verdict,
    })),
    falseAcceptsIntroduced: cases
      .filter(
        (item) =>
          item.reference === "fail" &&
          item.arms.jevOnly.verdict !== "pass" &&
          item.arms.cascade.verdict === "pass",
      )
      .map((item) => item.caseId),
  };
}
function receiptRationales(item: Case) {
  const baseline = kimi(item.baseline),
    selective = kimi(item.selective.receipt);
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        reference: item.referenceCriteria[key],
        baseline: baseline?.judgments[key] ?? null,
        selective: selective?.judgments[key] ?? null,
      },
    ]),
  );
}

/** Pure, deterministic scoring; only runCascadeAnalysis reads live artifacts. */
export function assessCascade(summary: Summary, bands: Bands) {
  if (
    summary.stage !== "kimi" ||
    !summary.byCase.length ||
    summary.byCase.some((item) => arms.some((arm) => !item.arms[arm].complete))
  )
    throw new Error("Analysis requires a resolved Kimi stage.");
  const cases = summary.byCase;
  const overall = Object.fromEntries(
    arms.map((arm) => [
      arm,
      cascadeConfusion(
        cases.map((item) => ({
          reference: ref(item.reference),
          decision: item.arms[arm].verdict,
        })),
      ),
    ]),
  ) as Record<Arm, ReturnType<typeof cascadeConfusion>>;
  const criteria = Object.fromEntries(
    keys.map((key) => [
      key,
      Object.fromEntries(
        arms.map((arm) => [
          arm,
          cascadeConfusion(
            cases.map((item) => ({
              reference: item.referenceCriteria[key].verdict,
              decision: cascadeCriterionDecision(item, key, arm),
            })),
          ),
        ]),
      ),
    ]),
  ) as Record<
    ConsolidationCriterion,
    Record<Arm, ReturnType<typeof cascadeConfusion>>
  >;
  const families = [...new Set(cases.map((item) => item.familyId))].map(
    (familyId) => {
      const selected = cases.filter((item) => item.familyId === familyId);
      return {
        familyId,
        cases: selected.length,
        referenceValid: selected.filter((item) => item.reference === "pass")
          .length,
        arms: Object.fromEntries(
          arms.map((arm) => {
            const outcome = cascadeConfusion(
              selected.map((item) => ({
                reference: ref(item.reference),
                decision: item.arms[arm].verdict,
              })),
            );
            return [
              arm,
              {
                ...outcome,
                anyValidAccepted: outcome.truePositive > 0,
                allValidAccepted:
                  outcome.referenceCounts.pass > 0 &&
                  outcome.truePositive === outcome.referenceCounts.pass,
              },
            ];
          }),
        ) as Record<
          Arm,
          ReturnType<typeof cascadeConfusion> & {
            anyValidAccepted: boolean;
            allValidAccepted: boolean;
          }
        >,
        recovery: recoveries(selected),
      };
    },
  );
  const familyCoverage = Object.fromEntries(
    arms.map((arm) => [
      arm,
      {
        totalFamilies: families.length,
        familiesWithValidReference: families.filter(
          (family) => family.referenceValid > 0,
        ).length,
        familiesWithAnyValidAccepted: families.filter(
          (family) => family.arms[arm].anyValidAccepted,
        ).length,
        familiesWithAllValidAccepted: families.filter(
          (family) => family.arms[arm].allValidAccepted,
        ).length,
        familiesWithFalseAccept: families.filter(
          (family) => family.arms[arm].falsePositive > 0,
        ).length,
        familiesWithError: families.filter(
          (family) => family.arms[arm].error > 0,
        ).length,
      },
    ]),
  ) as Record<
    Arm,
    {
      totalFamilies: number;
      familiesWithValidReference: number;
      familiesWithAnyValidAccepted: number;
      familiesWithAllValidAccepted: number;
      familiesWithFalseAccept: number;
      familiesWithError: number;
    }
  >;
  const autoAudit = Object.fromEntries(
    (["green", "red"] as const).map((state) => {
      const selected = cases.filter((item) => item.routing.state === state);
      return [
        state,
        {
          count: selected.length,
          cases: selected.map((item) => ({
            caseId: item.caseId,
            familyId: item.familyId,
            reference: item.reference,
            cascade: item.arms.cascade.verdict,
            baseline: item.arms.kimiOnly.verdict,
          })),
          vsReference: cascadeConfusion(
            selected.map((item) => ({
              reference: ref(item.reference),
              decision: item.arms.cascade.verdict,
            })),
          ),
          baselineDisagreements: selected
            .filter(
              (item) =>
                ["pass", "fail"].includes(item.arms.kimiOnly.verdict) &&
                item.arms.kimiOnly.verdict !== item.arms.cascade.verdict,
            )
            .map((item) => item.caseId),
          baselineUncertain: selected
            .filter((item) => item.arms.kimiOnly.verdict === "uncertain")
            .map((item) => item.caseId),
          baselineErrors: selected
            .filter((item) => item.arms.kimiOnly.verdict === "error")
            .map((item) => item.caseId),
        },
      ];
    }),
  ) as Record<
    "green" | "red",
    {
      count: number;
      cases: Array<{
        caseId: string;
        familyId: string;
        reference: CascadeVerdict;
        cascade: CascadeVerdict;
        baseline: CascadeVerdict;
      }>;
      vsReference: ReturnType<typeof cascadeConfusion>;
      baselineDisagreements: string[];
      baselineUncertain: string[];
      baselineErrors: string[];
    }
  >;
  const criterionAudit = Object.fromEntries(
    keys.map((key) => {
      const green = cases.filter((item) => item.routing.bands[key] === "green");
      const red = cases.filter((item) => item.routing.bands[key] === "red");
      const gray = cases.filter((item) => item.routing.bands[key] === "gray");
      const rescued = gray.filter(
        (item) =>
          item.referenceCriteria[key].verdict === "pass" &&
          item.arms.jevOnly.criteria[key] === "fail" &&
          kimi(item.selective.receipt)?.judgments[key]?.verdict === "pass",
      );
      return [
        key,
        {
          autoGreen: {
            count: green.length,
            referenceFail: green
              .filter((item) => item.referenceCriteria[key].verdict === "fail")
              .map((item) => item.caseId),
            referenceUncertain: green
              .filter(
                (item) => item.referenceCriteria[key].verdict === "uncertain",
              )
              .map((item) => item.caseId),
            baselineNonPass: green
              .filter((item) => item.arms.kimiOnly.criteria[key] !== "pass")
              .map((item) => ({
                caseId: item.caseId,
                verdict: item.arms.kimiOnly.criteria[key],
              })),
            baselineFail: green
              .filter((item) => item.arms.kimiOnly.criteria[key] === "fail")
              .map((item) => item.caseId),
            baselineUncertain: green
              .filter(
                (item) => item.arms.kimiOnly.criteria[key] === "uncertain",
              )
              .map((item) => item.caseId),
            baselineErrors: green
              .filter((item) => item.arms.kimiOnly.criteria[key] === "error")
              .map((item) => item.caseId),
          },
          autoRed: {
            count: red.length,
            referencePass: red
              .filter((item) => item.referenceCriteria[key].verdict === "pass")
              .map((item) => item.caseId),
            referenceUncertain: red
              .filter(
                (item) => item.referenceCriteria[key].verdict === "uncertain",
              )
              .map((item) => item.caseId),
          },
          gray: {
            count: gray.length,
            notEvaluated: gray.filter((item) => item.routing.state === "red")
              .length,
            actualKimiUncertain: gray
              .filter(
                (item) =>
                  kimi(item.selective.receipt)?.judgments[key]?.verdict ===
                  "uncertain",
              )
              .map((item) => item.caseId),
            validCriterionRescued: rescued.map((item) => item.caseId),
            familiesRescued: [...new Set(rescued.map((item) => item.familyId))],
          },
        },
      ];
    }),
  );
  const intentDiscrepancies = cases.flatMap<IntentDiscrepancy>((item) => {
    if (item.targetCriterion === null)
      return item.reference === "pass"
        ? []
        : [
            {
              caseId: item.caseId,
              familyId: item.familyId,
              variantId: item.variantId,
              intendedCriterion: null,
              intended: "pass" as const,
              actualReference: ref(item.reference),
              rationale: keys
                .filter((key) => item.referenceCriteria[key].verdict !== "pass")
                .map((key) => ({
                  criterion: key,
                  ...item.referenceCriteria[key],
                })),
            },
          ];
    const reference = item.referenceCriteria[item.targetCriterion];
    return reference.verdict === "fail"
      ? []
      : [
          {
            caseId: item.caseId,
            familyId: item.familyId,
            variantId: item.variantId,
            intendedCriterion: item.targetCriterion,
            intended: "fail" as const,
            actualReference: reference.verdict,
            rationale: [{ criterion: item.targetCriterion, ...reference }],
          },
        ];
  });
  const recovery = recoveries(cases);
  const decisiveCases = cases.flatMap((item) => {
    const reasons: string[] = [];
    if (item.reference === "fail" && item.arms.cascade.verdict === "pass")
      reasons.push("cascade_false_accept");
    if (item.reference === "fail" && item.arms.kimiOnly.verdict === "pass")
      reasons.push("baseline_false_accept");
    if (arms.some((arm) => item.arms[arm].verdict === "error"))
      reasons.push("technical_error");
    if (item.reference === "uncertain") reasons.push("uncertain_reference");
    if (arms.some((arm) => item.arms[arm].verdict === "uncertain"))
      reasons.push("uncertain_judgment");
    if (recovery.cases.includes(item.caseId)) reasons.push("valid_recovered");
    if (
      recovery.previouslyAcceptedNowBlocked.some(
        (other) => other.caseId === item.caseId,
      )
    )
      reasons.push("valid_lost");
    if (item.routing.state === "red" && item.reference === "pass")
      reasons.push("automatic_false_reject");
    if (
      keys.some(
        (key) =>
          item.routing.bands[key] === "green" &&
          item.referenceCriteria[key].verdict === "fail",
      )
    )
      reasons.push("criterion_green_false_accept");
    if (intentDiscrepancies.some((other) => other.caseId === item.caseId))
      reasons.push("design_reference_discrepancy");
    return reasons.length
      ? [
          {
            caseId: item.caseId,
            familyId: item.familyId,
            variantId: item.variantId,
            reference: item.reference,
            reasons,
            routing: item.routing,
            arms: item.arms,
            rationales: receiptRationales(item),
            receipts: {
              jev: `receipts/${item.jev.id}.json`,
              baseline: item.baseline
                ? `receipts/${item.baseline.id}.json`
                : null,
              selective: item.selective.receipt
                ? `receipts/${item.selective.receipt.id}.json`
                : null,
            },
          },
        ]
      : [];
  });
  const operational = summary.totals.byArm;
  const completeCost = (arm: Arm) =>
    operational[arm].usage.costUsd.missingJobs === 0 &&
    operational[arm].unreportedAttemptUsage === 0;
  const savedCalls = cases.filter(
    (item) => item.routing.state === "red" || item.routing.state === "green",
  ).length;
  return {
    protocolHash: summary.protocolHash,
    completedAt: summary.completedAt,
    uniqueCases: cases.length,
    uniqueFamilies: families.length,
    repetitions: summary.repetitions,
    developmentCases: bands.developmentCases ?? null,
    observationsPerDevelopmentCase: bands.observationsPerCase ?? null,
    bands,
    originalThresholds: JEV_CONSOLIDATION_THRESHOLDS,
    overall,
    criteria,
    families,
    familyCoverage,
    recovery,
    autoAudit,
    criterionAudit,
    intentDiscrepancies,
    decisiveCases,
    routing: summary.totals.states,
    cost: {
      experiment: summary.totals.actual,
      operational,
      perCall: summary.totals.byCall,
      cascadeMinusAllKimiUsd:
        completeCost("cascade") && completeCost("kimiOnly")
          ? operational.cascade.usage.costUsd.known -
            operational.kimiOnly.usage.costUsd.known
          : null,
      relativeCascadeSaving:
        completeCost("cascade") && completeCost("kimiOnly")
          ? ratio(
              operational.kimiOnly.usage.costUsd.known -
                operational.cascade.usage.costUsd.known,
              operational.kimiOnly.usage.costUsd.known,
            )
          : null,
      selectiveCallsAvoidedByAutomaticDecision: savedCalls,
      fractionSelectiveCallsAvoided: ratio(savedCalls, cases.length),
      selectiveCallsNotMadeBecauseJevFailed: cases.filter(
        (item) => item.routing.state === "error",
      ).length,
      distinctBaselineAndSelectiveCalls: true,
      reusedCalls: summary.totals.reusedCalls,
      caveat:
        "Arm totals overlap: experiment = Jev + full Kimi + selective Kimi; operational cascade = Jev + selective Kimi. Cached input and shared-batch serving can correlate requests and costs, including independent all-gray requests with identical bodies. Recorded batch differences do not establish isolated production savings.",
    },
    limits: [
      "The independent, fresh subagent without history is a frozen reference, not ground truth; design intent never overwrites its labels.",
      "New cases are correlated variants grouped into fictional source-disjoint families; the family count is the unit of independent coverage.",
      "One observation per model request; no stochastic stability estimate, confidence guarantee or production promotion.",
      "Uncertain or error means no application. Unevaluated gray criteria after a red proposal decision are skipped, not called uncertain Kimi judgments.",
    ],
  };
}
type Assessment = ReturnType<typeof assessCascade>;
type Timing = {
  firstStartedAt: string | null;
  lastCompletedAt: string | null;
  elapsedIntervalMs: number | null;
  note: string;
};
const escapeCell = (value: unknown) =>
  String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const table = (headers: string[], rows: unknown[][]) =>
  [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
const numeric = (value: number, digits = 2) =>
  value.toLocaleString("it-IT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const dollars = (value: number) => `${numeric(value, 6)} USD`;
const percent = (value: number | null) =>
  value === null ? "non calcolabile" : `${numeric(value * 100, 1)}%`;
const caseList = (items: string[]) =>
  items.length ? items.map((item) => `\`${item}\``).join(", ") : "nessuno";
function quoted(value: string) {
  return (value.length > 300 ? `${value.slice(0, 300)}…` : value)
    .replaceAll("\n", " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderCascadeReport(
  analysis: Assessment,
  timings: Record<"experiment" | "jev" | "kimi", Timing>,
  provenance: { summaryHash: string; analysisCodeHash: string },
  preflight: {
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
  } | null = null,
) {
  const a = analysis;
  const lines = [
    "# Confronto Jev, Kimi e cascata selettiva",
    "",
    `Risultati completati il ${a.completedAt}. ${a.uniqueCases} varianti correlate, raggruppate in ${a.uniqueFamilies} famiglie sintetiche nuove; ${a.repetitions} osservazione per richiesta. Il riferimento è il giudizio congelato di un subagente indipendente, avviato senza la cronologia dell’esperimento. Non viene trattato come verità definitiva.`,
    "",
    "## Esito complessivo",
    "",
    table(
      [
        "Braccio",
        "Validi accettati",
        "Validi respinti",
        "Non validi accettati",
        "Non validi respinti",
        "Giudizi incerti",
        "Errori",
        "Rif. incerti accettati",
      ],
      arms.map((arm) => {
        const c = a.overall[arm];
        return [
          armNames[arm],
          `${c.truePositive}/${c.referenceCounts.pass}`,
          c.falseNegative,
          `${c.falsePositive}/${c.referenceCounts.fail}`,
          c.trueNegative,
          c.uncertain,
          c.error,
          `${c.uncertainReferenceAccepted}/${c.referenceUncertain}`,
        ];
      }),
    ),
    "",
    "«Respinto» nella tabella significa un giudizio esplicito fail. Gli incerti e gli errori sono conteggiati separatamente e impediscono comunque l’applicazione. I riferimenti incerti sono esclusi dai conteggi di falso positivo e falso negativo. Le matrici complete, con tutti i denominatori, sono in [analysis.json](analysis.json).",
    "",
    `La cascata recupera ${a.recovery.count} proposte valide non accettate da Jev originale, distribuite in ${a.recovery.families.length} famiglie: ${a.recovery.grayResolved.length} recuperi passano dal giudizio selettivo sui criteri grigi, ${a.recovery.changedBandOnly.length} derivano dalle nuove soglie verdi. Proposte valide precedentemente accettate da Jev e poi bloccate: ${a.recovery.previouslyAcceptedNowBlocked.length}. Nuove false accettazioni rispetto a Jev: ${a.recovery.falseAcceptsIntroduced.length}.`,
    "",
    `Recuperi: ${caseList(a.recovery.cases)}. Nuove false accettazioni: ${caseList(a.recovery.falseAcceptsIntroduced)}.`,
    "",
    "## Copertura per famiglia",
    "",
    table(
      [
        "Braccio",
        "Famiglie con almeno un valido accettato",
        "Tutti i validi accettati",
        "Famiglie con false accettazioni",
        "Famiglie con errori",
      ],
      arms.map((arm) => {
        const f = a.familyCoverage[arm];
        return [
          armNames[arm],
          `${f.familiesWithAnyValidAccepted}/${f.familiesWithValidReference}`,
          `${f.familiesWithAllValidAccepted}/${f.familiesWithValidReference}`,
          f.familiesWithFalseAccept,
          f.familiesWithError,
        ];
      }),
    ),
    "",
    table(
      [
        "Famiglia",
        "Casi",
        "Validi di riferimento",
        "Validi accettati Jev / Kimi / cascata",
        "Recuperati",
      ],
      a.families.map((f) => [
        f.familyId,
        f.cases,
        f.referenceValid,
        arms.map((arm) => f.arms[arm].truePositive).join(" / "),
        f.recovery.count,
      ]),
    ),
    "",
    "## Metodo e soglie congelate",
    "",
    `Le bande sono state definite sui ${a.developmentCases ?? "non dichiarati"} casi già osservati, con ${a.observationsPerDevelopmentCase ?? "non dichiarate"} ripetizioni Jev per caso, prima dei giudizi sui nuovi casi. Quei dati costituiscono sviluppo e non sono più un insieme di verifica indipendente. Il margine predefinito è ${numeric(a.bands.margin ?? 0.05, 2)}; la procedura protegge i positivi e gli incerti dal rifiuto automatico, i negativi e gli incerti dall’accettazione automatica. Non sono state riadattate soglie ai risultati nuovi.`,
    "",
    table(
      [
        "Criterio",
        "Rosso se score <",
        "Grigio",
        "Verde se score ≥",
        "Soglia Jev originale",
      ],
      keys.map((key) => {
        const b = a.bands.criteria[key];
        return [
          criterionNames[key],
          numeric(b.rejectBelow),
          `[${numeric(b.rejectBelow)}; ${numeric(b.acceptAtOrAbove)})`,
          numeric(b.acceptAtOrAbove),
          numeric(a.originalThresholds[key]),
        ];
      }),
    ),
    "",
    "Un solo criterio rosso determina il rifiuto senza chiamata Kimi selettiva; tutti verdi determinano l’accettazione. Negli altri casi Kimi riceve l’intero input e la rubrica V2 completa, ma giudica soltanto i criteri grigi, senza punteggi, bande, etichette o riferimenti. Ogni suo giudizio sostituisce quel criterio; non si eseguono medie. Una seconda chiamata Kimi indipendente valuta comunque tutti e quattro i criteri di ogni proposta, compresi i due estremi. I risultati di questa baseline non sono riutilizzati dalla cascata. L’ordine delle due chiamate alterna per indice del caso e la concorrenza massima è tre. [Metodo completo](method.json), [bande](bands.json), [specifica](evaluation-spec.json), [rubrica](rubric.json).",
    "",
    "## Criteri e verifica delle decisioni automatiche",
    "",
    `Instradamento: ${a.routing.red ?? 0} proposte rosse, ${a.routing.green ?? 0} verdi, ${a.routing.gray ?? 0} grigie, ${a.routing.error ?? 0} con errore Jev. Le decisioni automatiche evitano ${a.cost.selectiveCallsAvoidedByAutomaticDecision}/${a.uniqueCases} chiamate selettive (${percent(a.cost.fractionSelectiveCallsAvoided)}). Altre ${a.cost.selectiveCallsNotMadeBecauseJevFailed} chiamate selettive mancano per errore Jev; non sono considerate un beneficio.`,
    "",
    table(
      [
        "Criterio",
        "Braccio",
        "TP",
        "FN",
        "FP",
        "TN",
        "Incerti",
        "Errori",
        "Non valutati",
        "Rif. incerti",
      ],
      keys.flatMap((key) =>
        arms.map((arm) => {
          const c = a.criteria[key][arm];
          return [
            criterionNames[key],
            armNames[arm],
            c.truePositive,
            c.falseNegative,
            c.falsePositive,
            c.trueNegative,
            c.uncertain,
            c.error,
            c.notEvaluated,
            c.referenceUncertain,
          ];
        }),
      ),
    ),
    "",
    "I criteri rimasti grigi in una proposta già rossa sono «non valutati»: vengono esclusi dal confronto per criterio e non rappresentano giudizi incerti di Kimi. TP/FN/FP/TN usano soltanto riferimenti e decisioni determinati.",
    "",
    `Fra le ${a.autoAudit.green.count} proposte automaticamente verdi: ${a.autoAudit.green.vsReference.falsePositive} false accettazioni e ${a.autoAudit.green.vsReference.uncertainReferenceAccepted} riferimenti incerti accettati. Baseline Kimi sui verdi: ${a.autoAudit.green.baselineDisagreements.length} giudizi opposti (fail: ${caseList(a.autoAudit.green.baselineDisagreements)}), ${a.autoAudit.green.baselineUncertain.length} incerti (${caseList(a.autoAudit.green.baselineUncertain)}), ${a.autoAudit.green.baselineErrors.length} errori tecnici (${caseList(a.autoAudit.green.baselineErrors)}). Fra le ${a.autoAudit.red.count} proposte automaticamente rosse: ${a.autoAudit.red.vsReference.falseNegative} validi respinti. Baseline Kimi sui rossi: ${a.autoAudit.red.baselineDisagreements.length} giudizi opposti (pass: ${caseList(a.autoAudit.red.baselineDisagreements)}), ${a.autoAudit.red.baselineUncertain.length} incerti (${caseList(a.autoAudit.red.baselineUncertain)}), ${a.autoAudit.red.baselineErrors.length} errori tecnici (${caseList(a.autoAudit.red.baselineErrors)}). Gli errori tecnici impediscono il confronto e non costituiscono un disaccordo semantico. I giudizi opposti sono segnali di revisione, non nuove etichette di verità.`,
    "",
    table(
      [
        "Criterio",
        "Verdi",
        "Verdi contro rif. fail",
        "Verdi contro rif. incerto",
        "Kimi sui verdi: fail / incerto / errore",
        "Rossi contro rif. pass",
        "Criteri validi recuperati da Kimi grigio",
      ],
      keys.map((key) => {
        const c = a.criterionAudit[key];
        return [
          criterionNames[key],
          c.autoGreen.count,
          c.autoGreen.referenceFail.length,
          c.autoGreen.referenceUncertain.length,
          `${c.autoGreen.baselineFail.length} / ${c.autoGreen.baselineUncertain.length} / ${c.autoGreen.baselineErrors.length}`,
          c.autoRed.referencePass.length,
          c.gray.validCriterionRescued.length,
        ];
      }),
    ),
    "",
    "La verifica dei criteri verdi include anche quelli contenuti in proposte respinte da un altro criterio. Un recupero per criterio non implica che l’intera proposta venga accettata.",
    "",
    "## Costi osservati, token e tempi",
    "",
    table(
      [
        "Percorso",
        "Chiamate distinte",
        "Tentativi HTTP",
        "Costo registrato",
        "Ricevute senza costo",
        "Token input noti",
        "Token output noti",
        "Token input in cache noti",
        "Somma tempi richieste",
      ],
      [
        ...arms.map((arm) => [armNames[arm], a.cost.operational[arm]] as const),
        ["Intero esperimento", a.cost.experiment] as const,
      ].map(([name, m]) => [
        name,
        m.jobs,
        m.requests,
        dollars(m.usage.costUsd.known),
        m.usage.costUsd.missingJobs,
        m.usage.inputTokens.known,
        m.usage.outputTokens.known,
        m.usage.cachedInputTokens.known,
        `${numeric(m.latencyMs / 1000)} s`,
      ]),
    ),
    "",
    `L’esperimento somma Jev + Kimi su quattro criteri + Kimi selettivo. Il percorso operativo della cascata somma soltanto Jev + Kimi selettivo; Kimi da solo usa soltanto la baseline completa. I totali dei bracci si sovrappongono e non vanno sommati tra loro. Tentativi senza uso contabilizzato: ${a.cost.experiment.unreportedAttemptUsage}. Costi mancanti restano ignoti e non vengono posti a zero.`,
    "",
    a.cost.cascadeMinusAllKimiUsd === null
      ? "Il costo totale della cascata rispetto a Kimi da solo non è confrontabile in modo completo perché mancano addebiti o uso di alcuni tentativi."
      : `Differenza registrata cascata meno Kimi da solo: ${dollars(a.cost.cascadeMinusAllKimiUsd)}; risparmio relativo osservato: ${percent(a.cost.relativeCascadeSaving)}.`,
    "",
    `Token input in cache riportati da Kimi: baseline ${a.cost.perCall.kimiBaseline.usage.cachedInputTokens.known} (${a.cost.perCall.kimiBaseline.usage.cachedInputTokens.missingJobs} ricevute senza dato), selettivo ${a.cost.perCall.kimiSelective.usage.cachedInputTokens.known} (${a.cost.perCall.kimiSelective.usage.cachedInputTokens.missingJobs} senza dato). La cache del batch e l’infrastruttura del provider possono correlare costi e risposte: anche con tutti i criteri grigi sono state fatte due chiamate separate, con corpo identico. Il confronto economico osservato non garantisce lo stesso risparmio in una produzione isolata.`,
    "",
    table(
      [
        "Intervallo osservato",
        "Inizio prima richiesta",
        "Fine ultima richiesta",
        "Tempo trascorso",
      ],
      (["experiment", "jev", "kimi"] as const).map((key) => [
        key,
        timings[key].firstStartedAt ?? "—",
        timings[key].lastCompletedAt ?? "—",
        timings[key].elapsedIntervalMs === null
          ? "—"
          : `${numeric(timings[key].elapsedIntervalMs / 1000)} s`,
      ]),
    ),
    "",
    "La somma delle latenze include tutti i tentativi misurati e non include l’attesa tra tentativi. Gli intervalli temporali includono concorrenza, attese ed eventuali pause fra le fasi; non sono stime di latenza seriale o di produzione. I tempi delle sole risposte riuscite restano nelle rispettive ricevute.",
    "",
    preflight
      ? `La prova tecnica preliminare è esclusa dalle metriche di validazione e dal totale dell’esperimento: costo registrato ${preflight.costUsd === null ? "ignoto" : dollars(preflight.costUsd)}, ${preflight.inputTokens ?? "ignoti"} token input, ${preflight.outputTokens ?? "ignoti"} output, ${preflight.cachedInputTokens ?? "ignoti"} input in cache. [Ricevuta della prova](kimi-preflight.json).`
      : "",
    "",
    "## Divergenze fra intenzione progettuale e riferimento",
    "",
    `${a.intentDiscrepancies.length} varianti non ricevono l’etichetta prevista dal disegno. I conteggi precedenti usano sempre il riferimento indipendente congelato. Per una variante difettosa si controlla il criterio bersaglio; per una variante prevista valida si controlla il giudizio complessivo.`,
    "",
    a.intentDiscrepancies.length
      ? table(
          ["Caso", "Variante", "Criterio bersaglio", "Previsto", "Riferimento"],
          a.intentDiscrepancies.map((item) => [
            item.caseId,
            item.variantId,
            item.intendedCriterion ?? "complessivo",
            item.intended,
            item.actualReference,
          ]),
        )
      : "Nessuna divergenza rilevata.",
    "",
    "## Casi decisivi e motivazioni",
    "",
    `${a.decisiveCases.length} casi presentano recuperi, errori, incertezze o disaccordi rilevanti. La tabella li conserva tutti; seguono estratti delle motivazioni per sei casi in ordine di priorità: false accettazioni della cascata, errori, poi le altre divergenze nell’ordine congelato. Tutte le motivazioni integrali sono in [analysis.json](analysis.json).`,
    "",
    a.decisiveCases.length
      ? table(
          ["Caso", "Famiglia", "Riferimento", "Jev / Kimi / cascata", "Motivi"],
          a.decisiveCases.map((item) => [
            `[${item.caseId}](${item.receipts.jev})`,
            item.familyId,
            item.reference,
            arms.map((arm) => item.arms[arm].verdict).join(" / "),
            item.reasons.join(", "),
          ]),
        )
      : "Nessun caso decisivo secondo le regole indicate.",
    "",
  ];
  const priority = (item: Assessment["decisiveCases"][number]) =>
    item.reasons.includes("cascade_false_accept")
      ? 0
      : item.reasons.includes("technical_error")
        ? 1
        : 2;
  for (const item of [...a.decisiveCases]
    .sort((left, right) => priority(left) - priority(right))
    .slice(0, 6)) {
    lines.push(
      `### ${item.caseId} · ${item.familyId}`,
      "",
      `Riferimento ${item.reference}; Jev ${item.arms.jevOnly.verdict}; Kimi ${item.arms.kimiOnly.verdict}; cascata ${item.arms.cascade.verdict}. Stato ${item.routing.state}.`,
      "",
    );
    const relevant = keys.filter((key) => {
      const judgments = item.rationales[key];
      return (
        judgments.reference.verdict !== "pass" ||
        item.arms.cascade.criteria[key] !== "pass" ||
        judgments.baseline?.verdict !== "pass" ||
        judgments.selective !== null
      );
    });
    for (const key of (relevant.length ? relevant : keys).slice(0, 2)) {
      const judgments = item.rationales[key];
      lines.push(
        `- **${criterionNames[key]}**. Riferimento ${judgments.reference.verdict}: ${quoted(judgments.reference.rationale)}${judgments.baseline ? ` Kimi completo ${judgments.baseline.verdict}: ${quoted(judgments.baseline.rationale)}` : " Kimi completo: esito tecnico non disponibile."}${judgments.selective ? ` Kimi selettivo ${judgments.selective.verdict}: ${quoted(judgments.selective.rationale)}` : ""}`,
      );
    }
    lines.push(
      "",
      `[Ricevuta Jev](${item.receipts.jev})${item.receipts.baseline ? ` · [Ricevuta Kimi completa](${item.receipts.baseline})` : ""}${item.receipts.selective ? ` · [Ricevuta Kimi selettiva](${item.receipts.selective})` : ""}`,
      "",
    );
  }
  lines.push(
    "## Limiti e tracciabilità",
    "",
    "Il nuovo campione è sintetico e piccolo: le varianti della stessa famiglia non sono osservazioni indipendenti. Una sola osservazione non misura stabilità stocastica, tassi di errore in produzione o calibrazione delle probabilità Jev. I giudizi incerti e gli errori bloccano l’applicazione senza generare nuovi compiti per persone. Nessun criterio di produzione viene cambiato e questo esperimento non costituisce una promozione del sistema.",
    "",
    `[Input](cases.json) · [Riferimento cieco](subagent-review.json) · [Partizione](partition.json) · [Dati di sviluppo](development.json) · [Separazione delle fonti](source-separation-audit.json) · [Protocollo](protocol.json) · [Protocollo Kimi](kimi-protocol.json) · [Riepilogo verificato](summary-kimi.json).`,
    "",
    `SHA-256 del riepilogo: ${provenance.summaryHash}. SHA-256 del codice di analisi: ${provenance.analysisCodeHash}.`,
    "",
  );
  return lines.join("\n");
}
async function optional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
async function immutable(path: string, text: string) {
  const existing = await optional(path);
  if (existing !== undefined) {
    if (existing !== text)
      throw new Error(
        "Existing analysis artifact differs; immutable output cannot be overwritten.",
      );
    return;
  }
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
}

export async function runCascadeAnalysis(input: string) {
  const directory = resolve(input);
  // This is the only path to artifact consumption: verification cannot call providers.
  const summary = await runCascade(
    { input: directory, stage: "kimi" },
    { verifyOnly: true },
  );
  const [
    summaryText,
    protocolText,
    bandsText,
    sourceCode,
    preflightText,
    priorText,
    specText,
  ] = await Promise.all([
    readFile(join(directory, "summary-kimi.json"), "utf8"),
    readFile(join(directory, "protocol.json"), "utf8"),
    readFile(join(directory, "bands.json"), "utf8"),
    readFile(fileURLToPath(import.meta.url)),
    optional(join(directory, "kimi-preflight.json")),
    optional(join(directory, "prior-attempt.json")),
    readFile(join(directory, "evaluation-spec.json"), "utf8"),
  ]);
  if (cascadeHash(JSON.parse(summaryText)) !== cascadeHash(summary))
    throw new Error("Verified summary changed before analysis.");
  const protocol = JSON.parse(protocolText);
  if (
    cascadeHash(protocol) !== summary.protocolHash ||
    protocol.artifactHashes["bands.json"] !== hashCascadeText(bandsText)
  )
    throw new Error("Verified protocol or bands changed before analysis.");
  const assessment = assessCascade(summary, JSON.parse(bandsText));
  const spec = JSON.parse(specText);
  if (
    protocol.artifactHashes["evaluation-spec.json"] !==
    hashCascadeText(specText)
  )
    throw new Error("Verified specification changed before analysis.");
  if (
    spec.priorAttemptHash &&
    (!priorText || hashCascadeText(priorText) !== spec.priorAttemptHash)
  )
    throw new Error("Prior attempt provenance differs.");
  const priorAttempt = priorText ? JSON.parse(priorText) : null;
  if (
    priorAttempt &&
    (typeof priorAttempt.priorRecordedCostUsd !== "number" ||
      !Number.isFinite(priorAttempt.priorRecordedCostUsd) ||
      priorAttempt.priorRecordedCostUsd < 0)
  )
    throw new Error("Invalid prior attempt cost.");
  const receipts = summary.byCase.flatMap((item) =>
    [item.jev, item.baseline, item.selective.receipt].filter(
      (receipt): receipt is CascadeReceipt => receipt !== null,
    ),
  );
  const starts = new Map<string, string>();
  const journalHashes: Record<string, string> = {};
  await Promise.all(
    receipts.map(async (receipt) => {
      const name = `receipts/${receipt.id}.json.attempts`;
      const text = await readFile(join(directory, name), "utf8");
      const envelope = JSON.parse(text);
      if (
        envelope.journalHash !== cascadeHash(envelope.journal) ||
        envelope.journal.protocolHash !== summary.protocolHash ||
        envelope.journal.attempts.length !== receipt.attempts
      )
        throw new Error("Verified attempt journal changed before analysis.");
      const startedAt = envelope.journal.attempts[0].startedAt;
      if (
        typeof startedAt !== "string" ||
        !Number.isFinite(Date.parse(startedAt))
      )
        throw new Error("Invalid request start timestamp.");
      starts.set(receipt.id, startedAt);
      journalHashes[name] = hashCascadeText(text);
    }),
  );
  function timing(selected: CascadeReceipt[]): Timing {
    const first = selected.length
      ? Math.min(
          ...selected.map((receipt) =>
            Date.parse(starts.get(receipt.id) ?? ""),
          ),
        )
      : null;
    const last = selected.length
      ? Math.max(...selected.map((receipt) => Date.parse(receipt.evaluatedAt)))
      : null;
    return {
      firstStartedAt: first === null ? null : new Date(first).toISOString(),
      lastCompletedAt: last === null ? null : new Date(last).toISOString(),
      elapsedIntervalMs: first === null || last === null ? null : last - first,
      note: "Observed interval includes concurrent requests, backoff and gaps; it is not the sum of request latency or a production benchmark.",
    };
  }
  const timings = {
    experiment: timing(receipts),
    jev: timing(receipts.filter((receipt) => receipt.kind === "jev")),
    kimi: timing(receipts.filter((receipt) => receipt.kind !== "jev")),
  };
  const preflight = preflightText
    ? (JSON.parse(preflightText)?.result?.usage ?? null)
    : null;
  const provenance = {
    summaryHash: hashCascadeText(summaryText),
    analysisCodeHash: hashCascadeText(sourceCode),
    protocolHash: summary.protocolHash,
    bandsHash: hashCascadeText(bandsText),
    journalHashes: Object.fromEntries(
      Object.entries(journalHashes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    preflightHash: preflightText ? hashCascadeText(preflightText) : null,
    priorAttemptHash: priorText ? hashCascadeText(priorText) : null,
  };
  const analysis = {
    version: 1,
    provenance,
    ...assessment,
    timings,
    priorAttempt,
    allInRecordedCostUsd:
      assessment.cost.experiment.usage.costUsd.known +
      (preflight?.costUsd ?? 0) +
      (priorAttempt?.priorRecordedCostUsd ?? 0),
    allInCostIncomplete:
      assessment.cost.experiment.usage.costUsd.missingJobs > 0 ||
      assessment.cost.experiment.unreportedAttemptUsage > 0 ||
      Boolean(preflight && preflight.costUsd === null),
    preflight: preflight
      ? {
          excludedFromValidation: true,
          costUsd: preflight.costUsd ?? null,
          inputTokens: preflight.inputTokens ?? null,
          outputTokens: preflight.outputTokens ?? null,
          cachedInputTokens: preflight.cachedInputTokens ?? null,
        }
      : null,
  };
  let report = renderCascadeReport(
    assessment,
    timings,
    provenance,
    analysis.preflight,
  );
  const operationalNote = priorAttempt
    ? `\nIl primo tentativo conservato separatamente comprende ${priorAttempt.priorSuccessfulJevJobs} richieste Jev riuscite e ${priorAttempt.priorKimiJobs} Kimi, per ${dollars(priorAttempt.priorRecordedCostUsd)}. Un’incoerenza dell’ordine di somma dei costi in virgola mobile ha interrotto la transizione prima di Kimi; i risultati originali sono rimasti intatti e l’esecuzione finale ripete Jev con aggregazione stabile. Input, riferimento e bande sono identici. Il confronto dei bracci usa soltanto l’esecuzione finale; il costo precedente è incluso esclusivamente nel totale sostenuto. [Provenienza del primo tentativo](prior-attempt.json).\n`
    : "";
  report = report.replace(
    "## Divergenze fra intenzione progettuale e riferimento",
    `${operationalNote}\nCosto complessivo registrato, inclusi prova tecnica ed eventuale primo tentativo: **${dollars(analysis.allInRecordedCostUsd)}**${analysis.allInCostIncomplete ? "; totale incompleto per dati di addebito mancanti" : ""}. Sono escluse eventuali richieste diagnostiche successive all’esperimento, contabilizzate separatamente.\n\n## Divergenze fra intenzione progettuale e riferimento`,
  );
  await immutable(
    join(directory, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  await immutable(join(directory, "rapporto.md"), report);
  return analysis;
}
async function main() {
  const { values } = parseArgs({ options: { input: { type: "string" } } });
  if (!values.input) throw new Error("Supply --input experiment directory.");
  const analysis = await runCascadeAnalysis(values.input);
  console.log(
    JSON.stringify({
      status: "analyzed",
      cases: analysis.uniqueCases,
      families: analysis.uniqueFamilies,
      analysis: join(resolve(values.input), "analysis.json"),
      report: join(resolve(values.input), "rapporto.md"),
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    console.error(
      "Cascade analysis stopped: complete verified results are required and existing analysis artifacts are immutable.",
    );
    process.exitCode = 1;
  });
