import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { fingerprint } from "../lib/canonical-json";
import { parseEvaluation } from "../lib/maintenance/consolidator/jev";
import {
  BASELINE_PROFILE,
  renderPrompt,
  validateProfile,
} from "../lib/maintenance/consolidator/prompts";
import { buildSnapshot } from "../lib/maintenance/consolidator/snapshot";
import type {
  ChangeSet,
  OperationKind,
} from "../lib/maintenance/consolidator/types";
import { verifyChangeSet } from "../lib/maintenance/consolidator/verifier";
import { BudgetStop, ModelAdapter, safeFailure } from "./apo/models";
import { ExperimentStore, type Manifest, usage } from "./apo/store";
import { fixturePage } from "./jev-missing-dataset";

/** Predeclared integration checks: final acceptance, using real batching and every applicable requirement. */
export function verifierAuditCases() {
  const fact =
    "Il centro astronomico Melograno apre la cupola soltanto agli iscritti accompagnati dal responsabile. Non sono ammesse visite autonome.";
  const detail =
    "Il telescopio usa un filtro solare rimovibile conservato nella custodia numerata.";
  const diary = "Ho riordinato la scheda e completato il consolidamento.";
  const make = (
    id: string,
    expected: boolean,
    original: string,
    result: string,
    kind: OperationKind = "deduplicate",
  ) => {
    const before = fixturePage("a", "Centro astronomico Melograno", original);
    const snapshot = buildSnapshot([before]);
    const changeSet: ChangeSet = {
      id,
      plan: {
        id: `operazione-${id}`,
        kind,
        findingIds: [],
        targetPageIds: ["a"],
        targetUnitIds: snapshot.units.map((u) => u.id),
        evidenceUnitIds: snapshot.units.map((u) => u.id),
        readSet: [{ pageId: "a", version: before.version }],
        goal:
          kind === "deduplicate"
            ? "Rimuovi la ripetizione, preservando tutte le informazioni e le loro precisazioni."
            : "Rimuovi il diario del consolidatore, preservando tutti i fatti del soggetto.",
      },
      draft: { noChange: false, patches: [], links: [] },
      changes: [{ before, after: { ...before, markdown: result } }],
    };
    return { id, expected, snapshot, changeSet };
  };
  const original = `${fact}\n\n${detail}\n\n${fact}`;
  const good = `${fact}\n\n${detail}`;
  const cases = [
    make("deduplicazione-corretta", true, original, good),
    make("fatto-distinto-perso", false, original, fact),
    make(
      "fatto-inventato",
      false,
      original,
      `${good}\n\nLe visite sono sempre gratuite.`,
    ),
    make(
      "condizione-eliminata",
      false,
      original,
      `${fact.replace("soltanto agli iscritti accompagnati dal responsabile", "a tutti i visitatori")}\n\n${detail}`,
    ),
    make(
      "diario-rimosso",
      true,
      `${good}\n\n${diary}`,
      good,
      "remove_maintenance_residue",
    ),
    make(
      "richiesta-umana-aggiunta",
      false,
      original,
      `${good}\n\nIl proprietario deve verificare il regolamento prima della prossima esecuzione.`,
    ),
    make("diario-aggiunto", false, original, `${good}\n\n${diary}`),
  ];
  const central = make(
    "centralizzazione-con-riferimento",
    true,
    fact,
    fact,
    "centralize",
  );
  const other = fixturePage(
    "b",
    "Promemoria della visita al centro Melograno",
    fact,
  );
  central.snapshot = buildSnapshot([central.snapshot.pages[0], other]);
  central.changeSet.plan.canonicalPageId = "a";
  central.changeSet.plan.targetPageIds = ["a", "b"];
  central.changeSet.plan.targetUnitIds = central.snapshot.units.map(
    (u) => u.id,
  );
  central.changeSet.plan.evidenceUnitIds = central.snapshot.units.map(
    (u) => u.id,
  );
  central.changeSet.plan.readSet = central.snapshot.pages.map((p) => ({
    pageId: p.id,
    version: p.version,
  }));
  central.changeSet.plan.goal =
    "Mantieni la regola nella scheda canonica a e sostituisci la ripetizione in b con un riferimento utile.";
  central.changeSet.changes = [
    {
      before: other,
      after: {
        ...other,
        markdown:
          "Per le condizioni di accesso alla cupola, consulta la [scheda del centro astronomico Melograno](/brain/a).",
      },
    },
  ];
  cases.push(central);
  return cases;
}

/** Snapshot capture time is operational metadata, absent from verifier request state. */
export function verifierAuditIdentity(
  cases: ReturnType<typeof verifierAuditCases>,
) {
  return fingerprint(
    cases.map((fixture) => ({
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        createdAt: "excluded-operational-capture-time",
      },
    })),
  );
}

async function main() {
  const [runPath, profilePath, outPath] = process.argv.slice(2);
  assert(runPath && profilePath && outPath, "Uso: RUN PROFILE OUT");
  const parent = new ExperimentStore(runPath);
  const mainManifest = await parent.read<Manifest>("manifest.json");
  assert.equal(
    (await parent.read<{ status: string }>("state.json")).status,
    "complete",
    "Complete the frozen experiment first",
  );
  const profile = validateProfile(
    JSON.parse(await readFile(resolve(profilePath), "utf8")),
  );
  const cases = verifierAuditCases();
  const unchangedVerifier =
    renderPrompt("verification", {}, profile) ===
    renderPrompt("verification", {}, BASELINE_PROFILE);
  const profiles = unchangedVerifier ? [profile] : [BASELINE_PROFILE, profile];
  const store = new ExperimentStore(outPath);
  const mainUsage = usage(await parent.calls());
  const cap = Math.min(0.1, mainManifest.config.maxDollars - mainUsage.dollars);
  assert(cap > 0, "No remaining budget for integration audit");
  const proposedManifest = {
    parentExperiment: mainManifest.id,
    profile,
    unchangedVerifier,
    comparedProfiles: profiles.map((p) => p.id),
    cases,
    repeats: 2,
    config: {
      ...mainManifest.config,
      maxDollars: cap,
      maxCalls: 200,
      maxTokens: 1_000_000,
    },
  };
  const previous = await store.maybe<typeof proposedManifest>(
    "audit-manifest.json",
  );
  const identity = (value: typeof proposedManifest) =>
    fingerprint({
      ...value,
      cases: verifierAuditIdentity(value.cases),
    });
  if (previous)
    assert.equal(
      identity(previous),
      identity(proposedManifest),
      "Audit input changed",
    );
  else await store.write("audit-manifest.json", proposedManifest, true);
  const manifest = previous ?? proposedManifest;
  loadEnvConfig(resolve(import.meta.dirname, ".."));
  const unlock = await store.lock();
  try {
    const adapter = new ModelAdapter(store, {
      ...mainManifest,
      config: manifest.config,
    });
    adapter.final = true;
    const outcomes = [];
    let consecutiveErrors = 0;
    for (const candidate of profiles) {
      for (const fixture of manifest.cases) {
        for (let repeat = 0; repeat < manifest.repeats; repeat++) {
          const id = `${candidate.id}-${fixture.id}-${repeat}`;
          const cached = await store.maybe<Record<string, unknown>>(
            `outcomes/${id}.json`,
          );
          if (cached) {
            outcomes.push(cached);
            consecutiveErrors = cached.error ? consecutiveErrors + 1 : 0;
            if (consecutiveErrors >= 3)
              throw new Error(
                "Three consecutive integration failures; inspect diagnostics",
              );
            continue;
          }
          let requestIndex = 0;
          let outcome: Record<string, unknown>;
          try {
            const result = await verifyChangeSet(
              fixture.snapshot,
              fixture.changeSet,
              async (request) => {
                const callId = `${id}-${requestIndex++}`;
                await store.write(`requests/${callId}.json`, request);
                const call = await adapter.call(
                  "evaluate",
                  { model: mainManifest.decisionModel, ...request },
                  callId,
                );
                const parsed = parseEvaluation(request, call.response);
                assert.equal(parsed.model, mainManifest.decisionModel);
                return parsed;
              },
              candidate,
            );
            outcome = {
              id,
              profile: candidate.id,
              case: fixture.id,
              repeat,
              expectedAcceptance: fixture.expected,
              passed: (result.status === "accepted") === fixture.expected,
              result,
              error: null,
            };
            consecutiveErrors = 0;
          } catch (error) {
            if (error instanceof BudgetStop) throw error;
            outcome = {
              id,
              profile: candidate.id,
              case: fixture.id,
              repeat,
              expectedAcceptance: fixture.expected,
              passed: false,
              error: safeFailure(error),
            };
            consecutiveErrors++;
          }
          await store.write(`outcomes/${id}.json`, outcome, true);
          outcomes.push(outcome);
          console.log(
            `${candidate.id} ${fixture.id} ${repeat}: ${outcome.passed ? "pass" : "fail"}`,
          );
          if (consecutiveErrors >= 3)
            throw new Error(
              "Three consecutive integration failures; inspect diagnostics",
            );
        }
      }
    }
    await store.write("audit.json", {
      parentExperiment: mainManifest.id,
      profile: profile.id,
      unchangedVerifier,
      outcomes,
      usage: usage(await store.calls()),
      limitations:
        "Eight constructed Italian whole-verifier scenarios from one fictional source family, two repeats. Diagnostic integration evidence, not a production accuracy estimate. No page writes or editor generation.",
    });
  } finally {
    await unlock();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Audit failed");
    process.exitCode = 1;
  });
