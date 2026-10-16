import { encode } from "gpt-tokenizer";
import { fingerprint } from "../../lib/canonical-json";
import type { PromptTask } from "../../lib/maintenance/consolidator/prompts";
import type { Metrics } from "./metrics";
import type { FrozenSelection } from "./runner";
import {
  type ExperimentStore,
  type Manifest,
  type SearchState,
  usage,
} from "./store";

type FinalResult = {
  before: Metrics;
  after: Metrics;
  delta: number;
  relativeDelta: number | null;
  interval: { lower: number; upper: number; groups: number };
  corrected: string[];
  regressions: string[];
  recommendation: string;
  limitations: string;
};
export async function report(store: ExperimentStore, manifest: Manifest) {
  const state = await store.maybe<SearchState>("state.json");
  const frozen = await store.maybe<FrozenSelection>("frozen.json");
  const spend = usage(await store.calls());
  const tasks: Partial<Record<PromptTask, unknown>> = {};
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const lines = [
    "# Esperimento APO per Jev",
    "",
    `Esperimento: \`${manifest.id}\`. Stato: **${state?.status ?? "prepared"}**.`,
    "",
    `Modello: \`${manifest.decisionModel}\`; optimizer: \`${manifest.config.optimizerModel}\`.`,
    "",
    manifest.config.smoke
      ? "**Smoke test ridotto: non è una valutazione definitiva.**"
      : "Dataset sintetico con etichette note per costruzione. Nessuna validazione umana o misura di accuratezza in produzione.",
    "",
    `Split: ${manifest.splits.train.length} training / ${manifest.splits.validation.length} validation / ${manifest.splits.test.length} test; seed ${manifest.config.seed}; ${manifest.config.repeats} ripetizioni. Le varianti della stessa fonte e i quasi duplicati rilevati rimangono nello stesso split.`,
    "",
    `Budget contabilizzato: $${spend.dollars.toFixed(6)}, ${spend.tokens} token, ${spend.calls} chiamate; costi non disponibili per ${spend.unknownCostCalls} chiamate (riserva prudenziale inclusa). Limiti: $${manifest.config.maxDollars}, ${manifest.config.maxTokens} token, ${manifest.config.maxCalls} chiamate. Costi senza valore provider stimati dal catalogo salvato; non sono fatture.`,
    "",
    `Arresto: ${frozen?.stoppedBy ?? "non congelato"}. Il test è accessibile solo dopo frozen.json; i risultati non sono restituiti all'optimizer.`,
    "",
    "| Task | Macro-F1 validation iniziale → selezionato | Macro-F1 test iniziale → selezionato | Δ test | IC 95% Δ | Esito |",
    "|---|---|---|---|---|---|",
  ];
  const details: string[] = [];
  for (const task of manifest.config.tasks) {
    const selected =
      frozen?.prompts[task] ??
      state?.tasks[task]?.prompt ??
      manifest.baseline[task];
    const beforeValidation = await store.maybe<Metrics>(
      `metrics/${task}-${fingerprint(manifest.baseline[task])}-validation.json`,
    );
    const afterValidation = await store.maybe<Metrics>(
      `metrics/${task}-${fingerprint(selected)}-validation.json`,
    );
    const result = await store.maybe<FinalResult>(`final/${task}.json`);
    const beforeTraining = await store.maybe<Metrics>(
      `metrics/${task}-${fingerprint(manifest.baseline[task])}-train.json`,
    );
    const afterTraining = await store.maybe<Metrics>(
      `metrics/${task}-${fingerprint(selected)}-train.json`,
    );
    tasks[task] = {
      beforeTraining,
      afterTraining,
      beforeValidation,
      afterValidation,
      final: result,
      history: state?.tasks[task]?.history ?? [],
      stoppedBy: state?.tasks[task]?.stoppedBy ?? null,
      prompt: {
        baselineCharacters: manifest.baseline[task].length,
        selectedCharacters: selected.length,
        baselineTokens: encode(manifest.baseline[task]).length,
        selectedTokens: encode(selected).length,
        selectedHash: fingerprint(selected),
      },
    };
    lines.push(
      `| ${task} | ${beforeValidation && afterValidation ? `${pct(beforeValidation.macroF1)} → ${pct(afterValidation.macroF1)}` : "incompleto"} | ${result ? `${pct(result.before.macroF1)} → ${pct(result.after.macroF1)}` : "non eseguito"} | ${result ? `${(result.delta * 100).toFixed(2)} pp` : "—"} | ${result ? `[${(result.interval.lower * 100).toFixed(2)}, ${(result.interval.upper * 100).toFixed(2)}] pp` : "—"} | ${result?.recommendation ?? "incompleto"} |`,
    );
    details.push(
      "",
      `## ${task}`,
      "",
      `Prompt: ${manifest.baseline[task].length} → ${selected.length} caratteri, ${encode(manifest.baseline[task]).length} → ${encode(selected).length} token stimati. Arresto: ${state?.tasks[task]?.stoppedBy ?? "non disponibile"}.`,
    );
    if (beforeTraining && afterTraining)
      details.push(
        "",
        `Training: ${beforeTraining.count} → ${afterTraining.count} predizioni; errori tecnici ${beforeTraining.failures} → ${afterTraining.failures}. Gli errori tecnici sono esclusi dal feedback all'optimizer ma restano nel denominatore delle metriche e nel registro dei costi.`,
      );
    if (result) {
      details.push(
        "",
        `Test: ${result.after.examples} esempi in ${result.after.sourceGroups} fonti indipendenti per costruzione. Accuracy ${pct(result.before.accuracy)} → ${pct(result.after.accuracy)}. Errori tecnici ${result.before.failures} → ${result.after.failures}; astensioni ${result.before.abstentions} → ${result.after.abstentions}.`,
        "",
        `Latenza media ${result.before.latencyMs.mean.toFixed(0)} → ${result.after.latencyMs.mean.toFixed(0)} ms, p95 ${result.before.latencyMs.p95.toFixed(0)} → ${result.after.latencyMs.p95.toFixed(0)} ms. Token input medi ${result.before.meanInputTokens?.toFixed(1) ?? "n/d"} → ${result.after.meanInputTokens?.toFixed(1) ?? "n/d"}; costo medio $${result.before.meanCostDollars?.toFixed(7) ?? "n/d"} → $${result.after.meanCostDollars?.toFixed(7) ?? "n/d"}.`,
        "",
        "| Classe | Precision prima → dopo | Recall prima → dopo |",
        "|---|---|---|",
      );
      for (const [label, value] of Object.entries(result.before.perClass))
        details.push(
          `| ${label} | ${pct(value.precision)} → ${pct(result.after.perClass[label].precision)} | ${pct(value.recall)} → ${pct(result.after.perClass[label].recall)} |`,
        );
      details.push(
        "",
        "| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |",
        "|---|---|---|",
      );
      for (const [language, value] of Object.entries(result.before.byLanguage))
        details.push(
          `| ${language} | ${pct(value.accuracy)} → ${pct(result.after.byLanguage[language].accuracy)} | ${pct(value.macroF1)} → ${pct(result.after.byLanguage[language].macroF1)} |`,
        );
      details.push(
        "",
        `Errori corretti: ${result.corrected.join(", ") || "nessuno"}.`,
        "",
        `Nuove regressioni: ${result.regressions.join(", ") || "nessuna"}.`,
      );
    }
  }
  lines.push(
    ...details,
    "",
    "## Interpretazione e riproducibilità",
    "",
    "La metrica primaria è macro-F1 alle soglie applicative originali: 0,8 per screening e preparazione, 0,7 per localizzazione; per il verificatore 0,8 su obiettivo e condotta, 0,65 sui singoli requisiti di integrità. Le choice sotto soglia sono astensioni, non risposte corrette. Il bootstrap è appaiato per fonte: ripetizioni e varianti non aumentano artificialmente la numerosità indipendente. Gli intervalli sono esplorativi su un campione piccolo, senza correzione per confronti multipli. La somiglianza dei template sintetici può sovrastimare la trasferibilità. Nessun risultato prova un miglioramento sui contenuti reali del Brain.",
    "",
    "Una selezione su validation non equivale a raccomandazione di adozione: il report richiede miglioramento nel test, intervallo inferiore positivo e assenza delle regressioni vietate per indicare candidate_for_review. Non viene effettuata alcuna promozione o scrittura al Brain. Per un ulteriore ciclo dopo il test usare nuove fonti indipendenti.",
    "",
    `Dataset SHA-256: \`${manifest.datasetHash}\`. Motore SHA-256: \`${manifest.engineHash}\`.`,
    "",
    "manifest.json conserva dataset, split, prompt originali, modelli, prezzi e configurazione; candidates/ conserva le proposte; calls/ richieste identificate da hash, risposte e spesa; predictions/ tutte le predizioni; selection/ le decisioni di selezione; frozen.json la scelta precedente al test; final/ le metriche finali. report.json include matrici di confusione, risultati per classe/lingua/categoria e provenienza della supervisione.",
    "",
  );
  const summary = {
    id: manifest.id,
    status: state?.status ?? "prepared",
    config: manifest.config,
    datasetHash: manifest.datasetHash,
    splits: manifest.splits,
    supervision: manifest.supervision,
    usage: spend,
    frozen,
    tasks,
  };
  await store.write("report.json", summary);
  await store.text("report.md", lines.join("\n"));
  return summary;
}
