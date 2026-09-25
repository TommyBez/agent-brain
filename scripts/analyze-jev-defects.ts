import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type ConsolidationCriterion as Criterion,
  CONSOLIDATION_CRITERIA as criteria,
} from "../lib/maintenance/consolidation-rubric";

import {
  armNames,
  type ByCriterion,
  type Decision,
  type DefectAnalysisCase,
  type DefectArm,
  type DefectBand,
  decideDefectRisk,
  defectArms,
  directions,
  grid,
  mapArms,
  mapCriteria,
  measure,
  names,
  type Observation,
  observations,
  type Reference,
  receiptRisk,
  refs,
  SELECTION_METHOD,
  selectThresholds,
  singleDecision,
} from "../lib/maintenance/defect-threshold-method";

export {
  type DefectAnalysisCase,
  decideDefectRisk,
  selectCriterionThresholds,
  selectThresholds,
} from "../lib/maintenance/defect-threshold-method";
export const DEFECT_SELECTION_METHOD = SELECTION_METHOD;
function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
type Summary = {
  protocolHash: string;
  phase: string;
  status: string;
  repetitions: number;
  byCase: DefectAnalysisCase[];
  totals: unknown;
};
type Matrix = Record<Reference, Record<Decision, number>>;
type Selected = ReturnType<typeof selectThresholds>;
type Selection = {
  version: number;
  method: typeof DEFECT_SELECTION_METHOD;
  protocolHash: string;
  calibrationSummaryHash: string;
  criteria: Selected;
};
function quantile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position),
    upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function distribution(values: number[]) {
  return {
    count: values.length,
    min: quantile(values, 0),
    p10: quantile(values, 0.1),
    q25: quantile(values, 0.25),
    median: quantile(values, 0.5),
    q75: quantile(values, 0.75),
    p90: quantile(values, 0.9),
    max: quantile(values, 1),
  };
}
function scorePosition(items: Observation[], band: DefectBand) {
  const byClass = Object.fromEntries(
    refs.map((reference) => [
      reference,
      distribution(
        items
          .filter((item) => item.reference === reference && item.risk !== null)
          .map((item) => item.risk as number),
      ),
    ]),
  ) as Record<Reference, ReturnType<typeof distribution>>;
  const byCase = [...new Set(items.map((item) => item.caseId))].map(
    (caseId) => {
      const all = items.filter((item) => item.caseId === caseId);
      const values = all
        .filter((item) => item.risk !== null)
        .map((item) => item.risk as number);
      const routes = all.map((item) => decideDefectRisk(item.risk, band));
      const low = band.allowBelow,
        high = band.rejectAtOrAbove;
      return {
        caseId,
        familyId: all[0].familyId,
        source: all[0].source ?? "unknown",
        reference: all[0].reference,
        risks: all.map((item) => item.risk),
        ...distribution(values),
        routes,
        crossesAllow:
          values.some((value) => value < low) &&
          values.some((value) => value >= low),
        crossesReject:
          values.some((value) => value < high) &&
          values.some((value) => value >= high),
        unstable: new Set(routes.filter((route) => route !== "error")).size > 1,
        errors: routes.filter((route) => route === "error").length,
      };
    },
  );
  const positives = items.filter(
    (item) => item.reference === "pass" && item.risk !== null,
  );
  const negatives = items.filter(
    (item) => item.reference === "fail" && item.risk !== null,
  );
  let ordered = 0;
  for (const good of positives)
    for (const bad of negatives)
      ordered +=
        (bad.risk as number) > (good.risk as number)
          ? 1
          : bad.risk === good.risk
            ? 0.5
            : 0;
  const classGap =
    positives.length && negatives.length
      ? Math.min(...negatives.map((item) => item.risk as number)) -
        Math.max(...positives.map((item) => item.risk as number))
      : null;
  return {
    byClass,
    perCaseMedian: Object.fromEntries(
      refs.map((reference) => [
        reference,
        distribution(
          byCase
            .filter(
              (item) => item.reference === reference && item.median !== null,
            )
            .map((item) => item.median as number),
        ),
      ]),
    ),
    perCaseRange: Object.fromEntries(
      refs.map((reference) => [
        reference,
        distribution(
          byCase
            .filter(
              (item) =>
                item.reference === reference &&
                item.min !== null &&
                item.max !== null,
            )
            .map((item) => (item.max as number) - (item.min as number)),
        ),
      ]),
    ),
    bySource: [...new Set(items.map((item) => item.source ?? "unknown"))].map(
      (source) => ({
        source,
        byClass: Object.fromEntries(
          refs.map((reference) => [
            reference,
            distribution(
              items
                .filter(
                  (item) =>
                    (item.source ?? "unknown") === source &&
                    item.reference === reference &&
                    item.risk !== null,
                )
                .map((item) => item.risk as number),
            ),
          ]),
        ),
      }),
    ),
    histogram: Array.from({ length: 20 }, (_, index) => ({
      from: index / 20,
      to: (index + 1) / 20,
      counts: Object.fromEntries(
        refs.map((reference) => [
          reference,
          items.filter(
            (item) =>
              item.reference === reference &&
              item.risk !== null &&
              item.risk >= index / 20 &&
              (item.risk < (index + 1) / 20 ||
                (index === 19 && item.risk === 1)),
          ).length,
        ]),
      ),
    })),
    classGap,
    classOverlap: classGap === null ? null : Math.max(0, -classGap),
    descriptivePairOrdering:
      positives.length && negatives.length
        ? ordered / (positives.length * negatives.length)
        : null,
    byCase,
    unstableCases: byCase.filter(
      (item) => item.unstable && !item.errors && item.count === 3,
    ).length,
    crossesAllowCases: byCase.filter(
      (item) => item.crossesAllow && !item.errors && item.count === 3,
    ).length,
    crossesRejectCases: byCase.filter(
      (item) => item.crossesReject && !item.errors && item.count === 3,
    ).length,
    completeCases: byCase.filter((item) => !item.errors && item.count === 3)
      .length,
    nearBoundaries: [0.01, 0.05, 0.1].map((distance) => ({
      distance,
      allow: items
        .filter(
          (item) =>
            item.risk !== null &&
            Number(Math.abs(item.risk - band.allowBelow).toFixed(12)) <=
              distance,
        )
        .map((item) => ({
          caseId: item.caseId,
          repeat: item.repeat,
          reference: item.reference,
          risk: item.risk,
        })),
      reject: items
        .filter(
          (item) =>
            item.risk !== null &&
            Number(Math.abs(item.risk - band.rejectAtOrAbove).toFixed(12)) <=
              distance,
        )
        .map((item) => ({
          caseId: item.caseId,
          repeat: item.repeat,
          reference: item.reference,
          risk: item.risk,
        })),
    })),
    mistakes: items
      .filter(
        (item) =>
          (item.reference === "fail" &&
            decideDefectRisk(item.risk, band) === "allow") ||
          (item.reference === "pass" &&
            decideDefectRisk(item.risk, band) === "reject"),
      )
      .map((item) => ({
        ...item,
        decision: decideDefectRisk(item.risk, band),
        allowMargin: item.risk === null ? null : item.risk - band.allowBelow,
        rejectMargin:
          item.risk === null ? null : item.risk - band.rejectAtOrAbove,
      })),
  };
}

function movedBand(
  band: DefectBand,
  boundary: keyof DefectBand,
  delta: number,
): DefectBand {
  const next = { ...band };
  next[boundary] =
    Math.round(Math.max(0, Math.min(1.01, band[boundary] + delta)) * 100) / 100;
  if (boundary === "allowBelow")
    next.allowBelow = Math.min(next.allowBelow, band.rejectAtOrAbove);
  else next.rejectAtOrAbove = Math.max(next.rejectAtOrAbove, band.allowBelow);
  return next;
}
function perGroups(
  items: Observation[],
  decide: (risk: number | null) => Decision,
) {
  return {
    total: measure(items, decide),
    byRepeat: [1, 2, 3].map((repeat) => ({
      repeat,
      ...measure(
        items.filter((item) => item.repeat === repeat),
        decide,
      ),
    })),
    byFamily: [...new Set(items.map((item) => item.familyId))].map(
      (familyId) => ({
        familyId,
        ...measure(
          items.filter((item) => item.familyId === familyId),
          decide,
        ),
      }),
    ),
    bySource: [...new Set(items.map((item) => item.source ?? "unknown"))].map(
      (source) => ({
        source,
        ...measure(
          items.filter((item) => (item.source ?? "unknown") === source),
          decide,
        ),
      }),
    ),
  };
}
function singleGrid(items: Observation[]) {
  return grid.map((threshold) => ({
    threshold,
    ...measure(items, (risk) => singleDecision(risk, threshold)),
  }));
}
function dualFrontier(items: Observation[]) {
  // Keep a small Pareto frontier. Unknown references are penalized as decisions,
  // never counted as successful autonomous outcomes.
  const cells = grid.flatMap((allowBelow, li) =>
    grid.slice(li).map((rejectAtOrAbove) => {
      const metrics = measure(items, (risk) =>
        decideDefectRisk(risk, { allowBelow, rejectAtOrAbove }),
      );
      return {
        allowBelow,
        rejectAtOrAbove,
        automatic: metrics.automatic,
        defectsMissed: metrics.defectsMissed,
        goodBlocked: metrics.goodBlocked,
        uncertainDecided: metrics.uncertainDecided,
      };
    }),
  );
  const distinct = new Map<string, (typeof cells)[number]>();
  for (const cell of cells) {
    const key = [
      cell.automatic,
      cell.defectsMissed,
      cell.goodBlocked,
      cell.uncertainDecided,
    ].join(":");
    const previous = distinct.get(key);
    const width = Math.round((cell.rejectAtOrAbove - cell.allowBelow) * 100);
    const oldWidth = previous
      ? Math.round((previous.rejectAtOrAbove - previous.allowBelow) * 100)
      : -1;
    if (
      !previous ||
      width > oldWidth ||
      (width === oldWidth && cell.allowBelow < previous.allowBelow)
    )
      distinct.set(key, cell);
  }
  const values = [...distinct.values()];
  return values.filter(
    (cell) =>
      !values.some(
        (other) =>
          other !== cell &&
          other.automatic >= cell.automatic &&
          other.defectsMissed <= cell.defectsMissed &&
          other.goodBlocked <= cell.goodBlocked &&
          other.uncertainDecided <= cell.uncertainDecided &&
          (other.automatic > cell.automatic ||
            other.defectsMissed < cell.defectsMissed ||
            other.goodBlocked < cell.goodBlocked ||
            other.uncertainDecided < cell.uncertainDecided),
      ),
  );
}
function proposalReference(row: DefectAnalysisCase): Reference {
  const labels = criteria.map((key) => row.referenceCriteria[key].verdict);
  return labels.includes("fail")
    ? "fail"
    : labels.includes("uncertain")
      ? "uncertain"
      : "pass";
}
export function simulateDefectProposals(
  rows: DefectAnalysisCase[],
  arm: DefectArm,
  bands: ByCriterion<DefectBand>,
) {
  const cases = rows.flatMap((row) =>
    [1, 2, 3].map((repeat) => {
      const receipt = row.receipts[arm].find((item) => item.repeat === repeat);
      const votes = mapCriteria((criterion) =>
        decideDefectRisk(
          receiptRisk(receipt, arm, criterion),
          bands[criterion],
        ),
      );
      const values = Object.values(votes);
      const decision: Decision = values.includes("error")
        ? "error"
        : values.includes("reject")
          ? "reject"
          : values.every((value) => value === "allow")
            ? "allow"
            : "defer";
      return {
        caseId: row.caseId,
        familyId: row.familyId,
        source: row.source ?? "unknown",
        repeat,
        reference: proposalReference(row),
        decision,
        criteria: votes,
        delegatedCriteria:
          decision === "defer"
            ? criteria.filter((criterion) => votes[criterion] === "defer")
            : [],
        risk: null,
      };
    }),
  );
  const summarized = (subset: typeof cases) => {
    const matrix = Object.fromEntries(
      refs.map((ref) => [
        ref,
        Object.fromEntries(
          directions.map((decision) => [
            decision,
            subset.filter(
              (item) => item.reference === ref && item.decision === decision,
            ).length,
          ]),
        ),
      ]),
    ) as Matrix;
    return {
      observations: subset.length,
      uniqueCases: new Set(subset.map((item) => item.caseId)).size,
      matrix,
      kimiCalls: subset.filter((item) => item.decision === "defer").length,
      delegatedCriteria: subset.reduce(
        (sum, item) => sum + item.delegatedCriteria.length,
        0,
      ),
      defectsMissed: matrix.fail.allow,
      goodBlocked: matrix.pass.reject,
      errors: refs.reduce((sum, ref) => sum + matrix[ref].error, 0),
    };
  };
  return {
    ...summarized(cases),
    byRepeat: [1, 2, 3].map((repeat) => ({
      repeat,
      ...summarized(cases.filter((item) => item.repeat === repeat)),
    })),
    byFamily: [...new Set(cases.map((item) => item.familyId))].map(
      (familyId) => ({
        familyId,
        ...summarized(cases.filter((item) => item.familyId === familyId)),
      }),
    ),
    bySource: [...new Set(cases.map((item) => item.source))].map((source) => ({
      source,
      ...summarized(cases.filter((item) => item.source === source)),
    })),
    cases,
  };
}

function complementComparison(
  rows: DefectAnalysisCase[],
  criterion: Criterion,
) {
  const values = rows.flatMap((row) =>
    [1, 2, 3].flatMap((repeat) => {
      const risks = mapArms((arm) =>
        receiptRisk(
          row.receipts[arm].find((receipt) => receipt.repeat === repeat),
          arm,
          criterion,
        ),
      );
      if (Object.values(risks).some((risk) => risk === null)) return [];
      return [
        {
          caseId: row.caseId,
          familyId: row.familyId,
          repeat,
          reference: row.referenceCriteria[criterion].verdict,
          positiveRisk: risks.positive as number,
          negativeRisk: risks.negative as number,
          defectRisk: risks.defect as number,
          literalComplementResidual:
            (risks.negative as number) - (risks.positive as number),
          defectVersusLiteral:
            (risks.defect as number) - (risks.negative as number),
          defectVersusPositive:
            (risks.defect as number) - (risks.positive as number),
        },
      ];
    }),
  );
  return {
    observations: values.length,
    uniqueCases: new Set(values.map((item) => item.caseId)).size,
    literalComplementResidual: distribution(
      values.map((item) => item.literalComplementResidual),
    ),
    absoluteComplementResidual: distribution(
      values.map((item) => Math.abs(item.literalComplementResidual)),
    ),
    byClass: Object.fromEntries(
      refs.map((reference) => {
        const selected = values.filter((item) => item.reference === reference);
        return [
          reference,
          {
            observations: selected.length,
            literalComplementResidual: distribution(
              selected.map((item) => item.literalComplementResidual),
            ),
            defectVersusLiteral: distribution(
              selected.map((item) => item.defectVersusLiteral),
            ),
            defectVersusPositive: distribution(
              selected.map((item) => item.defectVersusPositive),
            ),
          },
        ];
      }),
    ),
    cases: values,
  };
}

export function analyzeDefectScores(
  rows: DefectAnalysisCase[],
  selected: Selected,
  includeFrontiers = true,
) {
  const common = rows.filter((row) =>
    defectArms.every((arm) =>
      [1, 2, 3].every((repeat) =>
        row.receipts[arm].some(
          (receipt) =>
            receipt.repeat === repeat && receipt.outcome === "success",
        ),
      ),
    ),
  );
  const arms = mapArms((arm) => {
    const bands = mapCriteria((criterion) => selected[arm][criterion].dual);
    const proposed = simulateDefectProposals(rows, arm, bands);
    const byCriterion = mapCriteria((criterion) => {
      const items = observations(rows, arm, criterion);
      const band = bands[criterion];
      const thresholds = singleGrid(items);
      const commonItems = observations(common, arm, criterion);
      const frozenSingles = Object.fromEntries(
        Object.entries(selected[arm][criterion].single).map(
          ([name, threshold]) => [
            name,
            threshold === null
              ? null
              : {
                  threshold,
                  ...perGroups(items, (risk) =>
                    singleDecision(risk, threshold),
                  ),
                },
          ],
        ),
      );
      const sensitivity = (["allowBelow", "rejectAtOrAbove"] as const).flatMap(
        (boundary) =>
          [-0.1, -0.05, -0.01, 0.01, 0.05, 0.1].map((delta) => {
            const moved = movedBand(band, boundary, delta);
            const proposal = simulateDefectProposals(rows, arm, {
              ...bands,
              [criterion]: moved,
            });
            return {
              boundary,
              requestedDelta: delta,
              actualDelta: moved[boundary] - band[boundary],
              band: moved,
              criterion: perGroups(items, (risk) =>
                decideDefectRisk(risk, moved),
              ),
              proposal: {
                observations: proposal.observations,
                matrix: proposal.matrix,
                kimiCalls: proposal.kimiCalls,
                defectsMissed: proposal.defectsMissed,
                goodBlocked: proposal.goodBlocked,
                errors: proposal.errors,
              },
            };
          }),
      );
      const bestErrors = Math.min(
        ...thresholds.map((entry) => entry.defectsMissed + entry.goodBlocked),
      );
      return {
        frozenBand: band,
        position: scorePosition(items, band),
        frozen: perGroups(items, (risk) => decideDefectRisk(risk, band)),
        commonComplete: perGroups(commonItems, (risk) =>
          decideDefectRisk(risk, band),
        ),
        single: {
          frozen: frozenSingles,
          grid: thresholds,
          anchors: [0.1, 0.2, 0.5].map((threshold) => ({
            threshold,
            ...perGroups(items, (risk) => singleDecision(risk, threshold)),
          })),
          commonCompleteAnchors: [0.1, 0.2, 0.5].map((threshold) => ({
            threshold,
            ...perGroups(commonItems, (risk) =>
              singleDecision(risk, threshold),
            ),
          })),
          legacyPositiveCriterion:
            arm === "positive"
              ? {
                  originalRawPassAtOrAbove:
                    criterion === "meaningful_improvement" ? 0.8 : 0.9,
                  ...perGroups(items, (risk) =>
                    risk === null
                      ? "error"
                      : risk >
                          (criterion === "meaningful_improvement" ? 0.2 : 0.1)
                        ? "reject"
                        : "allow",
                  ),
                }
              : null,
          descriptiveOracleMinimumErrors: bestErrors,
          descriptiveOracleThresholds: thresholds
            .filter(
              (entry) => entry.defectsMissed + entry.goodBlocked === bestErrors,
            )
            .map((entry) => entry.threshold),
        },
        dualPareto: includeFrontiers ? dualFrontier(items) : [],
        sensitivity,
      };
    });
    return {
      byCriterion,
      proposals: proposed,
      commonCompleteProposals: simulateDefectProposals(common, arm, bands),
    };
  });
  return {
    uniqueCases: rows.length,
    commonCompleteCases: common.length,
    repetitions: 3,
    arms,
    complement: mapCriteria((criterion) =>
      complementComparison(rows, criterion),
    ),
  };
}

function n(value: number | null, digits = 2) {
  return value === null ? "—" : value.toFixed(digits);
}
function report(
  cal: ReturnType<typeof analyzeDefectScores>,
  val: ReturnType<typeof analyzeDefectScores>,
  selection: Selection,
) {
  const lines = [
    "# Jev: formulazione dei giudizi e simulazione delle soglie",
    "",
    `Confronto appaiato: ${cal.uniqueCases} proposte di calibrazione e ${val.uniqueCases} proposte di verifica, tre ripetizioni per formulazione. Le soglie dei tre metodi sono state congelate prima della verifica. Le ripetizioni non sono casi indipendenti.`,
    "",
    "Il rischio è 1 − punteggio della domanda positiva, oppure il punteggio della domanda negativa e di quella orientata ai difetti. Un valore maggiore significa maggiore rischio percepito. Non lo interpretiamo come probabilità calibrata di errore.",
    "",
    "Le tabelle contano osservazioni (caso × ripetizione), salvo dove indicato. Le decisioni automatiche sono simulazioni: non abbiamo chiesto a Kimi di giudicare le nuove deleghe e non ne deduciamo il risultato dai precedenti test.",
    "",
    "## Soglie congelate e risultato sulla verifica",
    "",
    "Sotto L il criterio è accettato; da U compreso è bocciato; fra L incluso e U escluso è delegato. Le soglie sono scelte per evitare, in calibrazione, qualunque difetto accettato o caso corretto bocciato in tutte le ripetizioni; i riferimenti incerti restano sempre delegati. Fra le soluzioni ammissibili massimizziamo le decisioni automatiche, poi preferiamo la fascia di riesame più ampia. Questo vincolo empirico non garantisce assenza di errori futuri.",
    "",
    "| Criterio | Domanda | L | U | Automatici | Delegati | Difetti accettati | Corretti bocciati | Errori tecnici |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const criterion of criteria)
    for (const arm of defectArms) {
      const item = val.arms[arm].byCriterion[criterion],
        result = item.frozen.total;
      lines.push(
        `| ${names[criterion]} | ${armNames[arm]} | ${n(item.frozenBand.allowBelow)} | ${n(item.frozenBand.rejectAtOrAbove)} | ${result.automatic}/${result.observations} | ${result.deferred} | ${result.defectsMissed} | ${result.goodBlocked} | ${result.errors} |`,
      );
    }
  lines.push("", "## Posizionamento per criterio", "");
  for (const criterion of criteria) {
    lines.push(
      `### ${names[criterion]}`,
      "",
      "| Domanda | Rischio corretti: min / mediana / max | Rischio difetti: min / mediana / max | Separazione estrema | Casi con esito instabile |",
      "|---|---|---|---:|---:|",
    );
    for (const arm of defectArms) {
      const item = val.arms[arm].byCriterion[criterion],
        position = item.position;
      const triple = (ref: Reference) => {
        const d = position.byClass[ref];
        return `${n(d.min)} / ${n(d.median)} / ${n(d.max)}`;
      };
      lines.push(
        `| ${armNames[arm]} | ${triple("pass")} | ${triple("fail")} | ${n(position.classGap)} | ${position.unstableCases}/${position.completeCases} |`,
      );
    }
    lines.push(
      "",
      "Una separazione estrema negativa indica sovrapposizione: qualche caso corretto riceve più rischio di almeno un difetto. La mediana da sola nasconde questa difficoltà.",
      "",
      "| Domanda | Soglia singola: priorità difetti | Difetti mancati / corretti bloccati | Soglia singola: priorità pochi falsi allarmi | Difetti mancati / corretti bloccati |",
      "|---|---:|---|---:|---|",
    );
    for (const arm of defectArms) {
      const chosen = selection.criteria[arm][criterion].single;
      const single = val.arms[arm].byCriterion[criterion].single.grid;
      const score = (threshold: number | null) => {
        const entry = single.find((item) => item.threshold === threshold);
        return entry
          ? `${entry.defectsMissed} / ${entry.goodBlocked}`
          : "copertura insufficiente";
      };
      lines.push(
        `| ${armNames[arm]} | ${n(chosen.defectFirst)} | ${score(chosen.defectFirst)} | ${n(chosen.lowFalseAlarms)} | ${score(chosen.lowFalseAlarms)} |`,
      );
    }
    lines.push(
      "",
      "Simulazioni di spostamento: cambiamo una sola soglia del criterio, mantenendo tutto il resto congelato. I contatori si riferiscono al criterio; le variazioni di chiamate riguardano l'intera proposta.",
      "",
      "| Domanda | Movimento | L / U risultanti | Δ deleghe a Kimi | Difetti accettati | Corretti bocciati |",
      "|---|---|---|---:|---:|---:|",
    );
    for (const arm of defectArms)
      for (const entry of val.arms[arm].byCriterion[criterion].sensitivity) {
        const base = val.arms[arm].proposals;
        lines.push(
          `| ${armNames[arm]} | ${entry.boundary === "allowBelow" ? "L" : "U"} ${entry.requestedDelta > 0 ? "+" : ""}${n(entry.requestedDelta)} | ${n(entry.band.allowBelow)} / ${n(entry.band.rejectAtOrAbove)} | ${entry.proposal.kimiCalls - base.kimiCalls} | ${entry.criterion.total.defectsMissed} | ${entry.criterion.total.goodBlocked} |`,
        );
      }
    const residual = val.complement[criterion];
    lines.push(
      "",
      `Inversione letterale: residuo mediano rispetto al complemento della domanda positiva ${n(residual.literalComplementResidual.median)}; scarto assoluto mediano ${n(residual.absoluteComplementResidual.median)}. Zero indicherebbe risposte complementari. Campione comune: ${residual.uniqueCases} casi, ${residual.observations} osservazioni.`,
      "",
    );
  }
  lines.push(
    "## Conseguenze sull'intera proposta",
    "",
    "Un criterio rosso basta a bocciare la proposta. Tutti verdi consentono l'applicazione simulata. Altrimenti è prevista una sola chiamata Kimi per i criteri intermedi. Gli errori tecnici sono separati e impediscono applicazione.",
    "",
    "| Domanda | Buone approvate / buone | Cattive approvate / cattive | Buone bocciate | Deleghe Kimi | Criteri delegati | Errori |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const arm of defectArms) {
    const p = val.arms[arm].proposals;
    const total = (ref: Reference) =>
      Object.values(p.matrix[ref]).reduce((sum, value) => sum + value, 0);
    lines.push(
      `| ${armNames[arm]} | ${p.matrix.pass.allow}/${total("pass")} | ${p.matrix.fail.allow}/${total("fail")} | ${p.goodBlocked} | ${p.kimiCalls}/${p.observations} | ${p.delegatedCriteria} | ${p.errors} |`,
    );
  }
  lines.push(
    "",
    `Il campione comune completo comprende ${val.commonCompleteCases}/${val.uniqueCases} casi. analysis.json contiene confronti identici per caso, ripetizione e famiglia, tutti i 102 valori di soglia singola, frontiere di calibrazione, margini individuali e attraversamenti delle soglie. visual-data.json contiene i dati per simulazioni interattive.`,
    "",
    "## Limiti e interpretazione",
    "",
    "La verifica non seleziona nuove soglie. I minimi descrittivi della griglia di verifica sono risultati retrospettivi, non prestazioni validate di una configurazione scelta prima. Nessun intervallo di confidenza binomiale usa le tre ripetizioni come osservazioni indipendenti. Il confronto delle formulazioni misura il comportamento empirico sullo stesso materiale, non dimostra una spiegazione interna del modello.",
    "",
    "Con una soglia singola bocciamo per rischio ≥ t. Il vecchio gate positivo approvava per punteggio ≥ soglia: all'uguaglianza esatta i due confronti non sono complementari. Nessun risultato qui viene spacciato per una replica numericamente identica del vecchio gate.",
    "",
  );
  return lines.join("\n");
}

async function immutable(path: string, content: string) {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== content)
      throw new Error(`Refusing to overwrite changed artifact: ${path}`);
  }
}

export async function runDefectAnalysis(
  input: string,
  stage: "select" | "analyze",
) {
  const { runDefects } = await import("./evaluate-jev-defects");
  await runDefects({ input, phase: "calibration" }, { verifyOnly: true });
  if (stage === "analyze")
    await runDefects({ input, phase: "validation" }, { verifyOnly: true });
  const calibrationText = await readFile(
    join(input, "summary-calibration.json"),
    "utf8",
  );
  const calibration: Summary = JSON.parse(calibrationText);
  const protocolText = await readFile(join(input, "protocol.json"), "utf8");
  const protocolHash = hash(JSON.stringify(JSON.parse(protocolText)));
  if (
    calibration.protocolHash !== protocolHash ||
    calibration.repetitions !== 3
  )
    throw new Error("Calibration protocol mismatch.");
  const selected = selectThresholds(calibration.byCase);
  const selection: Selection = {
    version: 1,
    method: DEFECT_SELECTION_METHOD,
    protocolHash,
    calibrationSummaryHash: hash(calibrationText),
    criteria: selected,
  };
  const selectionText = `${JSON.stringify(selection, null, 2)}\n`;
  if (stage === "select") {
    await immutable(join(input, "selection.json"), selectionText);
    return selection;
  }
  if ((await readFile(join(input, "selection.json"), "utf8")) !== selectionText)
    throw new Error("Frozen selection no longer matches calibration.");
  const validationText = await readFile(
    join(input, "summary-validation.json"),
    "utf8",
  );
  const validation: Summary = JSON.parse(validationText);
  if (
    validation.protocolHash !== protocolHash ||
    validation.repetitions !== 3 ||
    validation.byCase.some((row) => row.split !== "validation")
  )
    throw new Error("Validation protocol mismatch.");
  const oldCases = new Set(calibration.byCase.map((row) => row.caseId));
  const oldFamilies = new Set(calibration.byCase.map((row) => row.familyId));
  if (
    validation.byCase.some(
      (row) => oldCases.has(row.caseId) || oldFamilies.has(row.familyId),
    )
  )
    throw new Error("Validation families overlap calibration.");
  const cal = analyzeDefectScores(calibration.byCase, selected);
  const val = analyzeDefectScores(validation.byCase, selected, false);
  const analysis = {
    method: DEFECT_SELECTION_METHOD,
    protocolHash,
    calibrationSummaryHash: hash(calibrationText),
    validationSummaryHash: hash(validationText),
    selectionHash: hash(selectionText),
    calibration: cal,
    validation: val,
    apiTotals: {
      calibration: calibration.totals,
      validation: validation.totals,
    },
  };
  await immutable(
    join(input, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  const visualRows = (rows: DefectAnalysisCase[]) =>
    rows.map((row) => ({
      caseId: row.caseId,
      familyId: row.familyId,
      source: row.source ?? "unknown",
      reference: mapCriteria(
        (criterion) => row.referenceCriteria[criterion].verdict,
      ),
      risks: mapArms((arm) =>
        mapCriteria((criterion) =>
          [1, 2, 3].map((repeat) =>
            receiptRisk(
              row.receipts[arm].find((receipt) => receipt.repeat === repeat),
              arm,
              criterion,
            ),
          ),
        ),
      ),
    }));
  const visuals = {
    method: DEFECT_SELECTION_METHOD,
    selection: selected,
    criterionNames: names,
    armNames,
    criteria,
    arms: defectArms,
    calibration: visualRows(calibration.byCase),
    validation: visualRows(validation.byCase),
    calibrationFrontiers: mapArms((arm) =>
      mapCriteria(
        (criterion) => cal.arms[arm].byCriterion[criterion].dualPareto,
      ),
    ),
  };
  await immutable(
    join(input, "visual-data.json"),
    `${JSON.stringify(visuals)}\n`,
  );
  await immutable(
    join(input, "rapporto-soglie.md"),
    report(cal, val, selection),
  );
  return analysis;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: { input: { type: "string" }, stage: { type: "string" } },
    strict: true,
  });
  if (!values.input || !["select", "analyze"].includes(values.stage ?? ""))
    throw new Error("Usage: --input <experiment-dir> --stage select|analyze");
  const output = resolve(values.input);
  runDefectAnalysis(output, values.stage as "select" | "analyze")
    .then(() => console.log(JSON.stringify({ stage: values.stage, output })))
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Analysis failed.",
      );
      process.exitCode = 1;
    });
}
