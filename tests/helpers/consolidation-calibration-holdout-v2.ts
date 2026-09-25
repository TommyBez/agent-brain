import type { BrainPage } from "../../lib/brain/types";
import { buildSnapshot } from "../../lib/maintenance/consolidator/snapshot";
import type {
  Draft,
  OperationKind,
  OperationPlan,
  Snapshot,
} from "../../lib/maintenance/consolidator/types";
import type { CalibrationCase } from "./consolidation-calibration-cases";

type UnitRef = { pageId: string; paragraph: number };
type Edit = UnitRef & { after: string };
type Scenario = {
  id: string;
  category: string;
  pages: BrainPage[];
  kind: OperationKind;
  goal: string;
  safe: Edit[];
  unsafe: Edit[];
  violation: string;
  keeper?: UnitRef;
  canonicalPageId?: string;
  resolution?: OperationPlan["resolution"];
  corrections?: UnitRef[];
  safeSummary?: Draft["summaryPatches"];
  unsafeSummary?: Draft["summaryPatches"];
};

function page(
  id: string,
  title: string,
  paragraphs: string[],
  summary = "",
): BrainPage {
  return {
    id,
    slug: id,
    title,
    type: "note",
    markdown: paragraphs.join("\n\n"),
    summary,
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

function exactUnit(snapshot: Snapshot, reference: UnitRef) {
  const unit = snapshot.units.filter(
    (candidate) => candidate.pageId === reference.pageId,
  )[reference.paragraph];
  if (!unit) throw new Error(`Unknown holdout unit ${reference.pageId}`);
  return unit;
}

function pair(scenario: Scenario): CalibrationCase[] {
  return [true, false].map((expectedAccept) => {
    const snapshot = buildSnapshot(scenario.pages, "2026-09-25T00:00:00.000Z");
    const id = `holdout-v2-${scenario.id}-${expectedAccept ? "safe" : "unsafe"}`;
    const edits = expectedAccept ? scenario.safe : scenario.unsafe;
    const targetUnitIds = new Set(
      edits.map((edit) => exactUnit(snapshot, edit).id),
    );
    const targetPageIds = new Set(edits.map((edit) => edit.pageId));
    const keeper = scenario.keeper
      ? exactUnit(snapshot, scenario.keeper)
      : undefined;
    if (keeper) {
      targetUnitIds.add(keeper.id);
      targetPageIds.add(keeper.pageId);
    }
    if (scenario.canonicalPageId) targetPageIds.add(scenario.canonicalPageId);
    const plan: OperationPlan = {
      id: `plan-${id}`,
      kind: scenario.kind,
      findingIds: [`finding-${id}`],
      targetPageIds: [...targetPageIds],
      targetUnitIds: [...targetUnitIds],
      evidenceUnitIds: snapshot.units.map((unit) => unit.id),
      readSet: snapshot.pages.map(({ id: pageId, version }) => ({
        pageId,
        version,
      })),
      goal: scenario.goal,
      ...(keeper ? { retainedUnitId: keeper.id } : {}),
      ...(scenario.canonicalPageId
        ? { canonicalPageId: scenario.canonicalPageId }
        : {}),
      ...(scenario.resolution ? { resolution: scenario.resolution } : {}),
      ...(scenario.corrections
        ? {
            correctionUnitIds: scenario.corrections.map(
              (reference) => exactUnit(snapshot, reference).id,
            ),
          }
        : {}),
    };
    const summaryPatches = expectedAccept
      ? scenario.safeSummary
      : scenario.unsafeSummary;
    return {
      id,
      scenarioId: `v2-${scenario.id}`,
      split: "holdout" as const,
      category: scenario.category,
      snapshot,
      plan,
      draft: {
        noChange: false,
        links: [],
        patches: edits.map((edit) => {
          const unit = exactUnit(snapshot, edit);
          return {
            pageId: edit.pageId,
            unitId: unit.id,
            before: unit.text,
            after: edit.after,
          };
        }),
        ...(summaryPatches ? { summaryPatches } : {}),
      },
      expectedAccept,
      ...(!expectedAccept ? { expectedViolation: scenario.violation } : {}),
    };
  });
}

/**
 * Second, prospectively labeled holdout. Entirely fictional source texts were
 * authored without provider outcomes. Never alter these cases after collection.
 * Technical page timestamps are deliberately not factual dates of the subjects.
 */
export function calibrationHoldoutV2Cases(): CalibrationCase[] {
  const bookingRule =
    "La riserva fittizia di sedie pieghevoli Cedro contiene 120 sedie; ogni carrello ne trasporta 10. Fonte: inventario completo C-31: «Disponibili 120 sedie pieghevoli e carrelli da 10 sedie».";
  const bookingExtra =
    "La riserva Cedro contiene 120 sedie pieghevoli. Per ritirarle occorre presentare una tessera attiva e prenotare almeno 48 ore prima. Fonte inventario C-31: «Disponibili 120 sedie pieghevoli». Fonte regolamento C-32: «Ritiro consentito soltanto con tessera attiva e prenotazione effettuata almeno 48 ore prima».";
  const bookingMerged =
    "La riserva fittizia di sedie pieghevoli Cedro contiene 120 sedie; ogni carrello ne trasporta 10. Fonte inventario C-31: «Disponibili 120 sedie pieghevoli e carrelli da 10 sedie». Per il ritiro occorre una tessera attiva e una prenotazione di almeno 48 ore prima. Fonte regolamento C-32: «Ritiro consentito soltanto con tessera attiva e prenotazione effettuata almeno 48 ore prima».";
  const bindingA =
    "Il volume sperimentale fittizio Nodo ha una coperta in lino. Testo completo della scheda N-A: «Coperta in lino. La cucitura del campione A sopporta una trazione di 75 N».";
  const bindingB =
    "Il volume sperimentale fittizio Nodo ha una coperta in lino. Testo completo della scheda N-B: «Coperta in lino. La cucitura del campione B sopporta una trazione di 80 N».";
  const bindingMerged =
    "Il volume sperimentale fittizio Nodo ha una coperta in lino, come riportano le schede N-A e N-B. La cucitura del campione A sopporta una trazione di 75 N secondo N-A; quella del campione B sopporta 80 N secondo N-B.";
  const converter =
    "Il convertitore fittizio Onda crea una copia PNG del disegno e non sovrascrive il file SVG originale. Specifica integrale O-44: «Produci una copia PNG; conserva il file SVG originale senza modificarlo».";
  const lockerSummary =
    "La banca dei semi fittizia Germoglio ha 6 scomparti numerati secondo l'inventario G-60. L'accesso è consentito soltanto ai soci con tessera attiva, secondo il regolamento G-1.";
  const loanOriginal =
    "La regola attuale del prestito del centro giochi fittizio Cubo permette al massimo 2 giochi contemporaneamente. Ogni prestito dura al massimo 14 giorni. Fonte dichiarata: circolare C-70.";
  const textual = [
    {
      id: "chair-reservation",
      category: "centralize-required-condition",
      pages: [
        page("h2-chair-stock", "Riserva di sedie Cedro", [bookingRule]),
        page("h2-chair-pickup", "Ritiro delle sedie Cedro", [bookingExtra]),
      ],
      kind: "centralize" as const,
      goal: "Riunisci nella scheda della riserva quantità, carrelli e condizioni di ritiro, conservando fonti e un rinvio utile nella pagina di ritiro.",
      safe: [
        { pageId: "h2-chair-stock", paragraph: 0, after: bookingMerged },
        {
          pageId: "h2-chair-pickup",
          paragraph: 0,
          after:
            "Per quantità e condizioni di ritiro delle sedie Cedro, consulta la [scheda della riserva](/pages/h2-chair-stock).",
        },
      ],
      unsafe: [
        {
          pageId: "h2-chair-stock",
          paragraph: 0,
          after:
            "La riserva fittizia Cedro contiene 120 sedie pieghevoli; ogni carrello ne trasporta 10, secondo l'inventario C-31. È possibile ritirarle senza prenotazione presentando una tessera attiva, secondo il regolamento C-32.",
        },
        {
          pageId: "h2-chair-pickup",
          paragraph: 0,
          after:
            "Per quantità e condizioni di ritiro delle sedie Cedro, consulta la [scheda della riserva](/pages/h2-chair-stock).",
        },
      ],
      violation: "conditions",
      canonicalPageId: "h2-chair-stock",
      keeper: { pageId: "h2-chair-stock", paragraph: 0 },
    },
    {
      id: "binding-test-sources",
      category: "centralize-source-association",
      pages: [
        page("h2-binding-record", "Scheda dei campioni del volume Nodo", [
          bindingA,
        ]),
        page("h2-binding-note", "Nota sul secondo campione Nodo", [bindingB]),
      ],
      kind: "centralize" as const,
      goal: "Riunisci nella scheda dei campioni coperta e misure delle due cuciture con la corretta associazione tra campione, valore e fonte; lascia nella nota un riferimento.",
      safe: [
        { pageId: "h2-binding-record", paragraph: 0, after: bindingMerged },
        {
          pageId: "h2-binding-note",
          paragraph: 0,
          after:
            "Per le misure del campione B del volume Nodo, consulta la [scheda dei campioni](/pages/h2-binding-record).",
        },
      ],
      unsafe: [
        {
          pageId: "h2-binding-record",
          paragraph: 0,
          after:
            "Il volume sperimentale fittizio Nodo ha una coperta in lino, come riportano le schede N-A e N-B. La cucitura del campione A sopporta una trazione di 80 N secondo N-B; quella del campione B sopporta 75 N secondo N-A.",
        },
        {
          pageId: "h2-binding-note",
          paragraph: 0,
          after:
            "Per le misure del campione B del volume Nodo, consulta la [scheda dei campioni](/pages/h2-binding-record).",
        },
      ],
      violation: "provenance",
      canonicalPageId: "h2-binding-record",
      keeper: { pageId: "h2-binding-record", paragraph: 0 },
    },
    {
      id: "converter-negation",
      category: "deduplicate-negation",
      pages: [
        page("h2-converter", "Comportamento del convertitore Onda", [
          converter,
          converter,
        ]),
      ],
      kind: "deduplicate" as const,
      goal: "Elimina il secondo passaggio duplicato preservando la copia PNG e la protezione del file SVG originale.",
      safe: [{ pageId: "h2-converter", paragraph: 1, after: "" }],
      unsafe: [
        {
          pageId: "h2-converter",
          paragraph: 0,
          after:
            "Il convertitore fittizio Onda crea una copia PNG del disegno e sovrascrive il file SVG originale. Fonte: specifica O-44.\n\n",
        },
        { pageId: "h2-converter", paragraph: 1, after: "" },
      ],
      violation: "negations",
      keeper: { pageId: "h2-converter", paragraph: 0 },
    },
    {
      id: "seed-bank-summary",
      category: "correction-summary-unique-condition",
      pages: [
        page(
          "h2-seed-bank",
          "Scomparti della banca dei semi Germoglio",
          [
            "La banca dei semi fittizia Germoglio ha 6 scomparti numerati. Fonte dichiarata: inventario G-60.",
          ],
          lockerSummary,
        ),
        page("h2-seed-inventory", "Testo originale inventario G-60", [
          "Testo originale integrale dell'inventario G-60: «La banca dei semi Germoglio ha 60 scomparti numerati. Il valore 6 nella scheda e nella sintesi è un errore di trascrizione: il numero corretto è 60». Il documento non modifica le regole di accesso.",
        ]),
      ],
      kind: "reconcile" as const,
      goal: "Correggi 6 in 60 scomparti nella scheda e nella sintesi secondo la rettifica originale G-60, senza perdere la condizione di accesso contenuta soltanto nella sintesi.",
      safe: [
        {
          pageId: "h2-seed-bank",
          paragraph: 0,
          after:
            "La banca dei semi fittizia Germoglio ha 60 scomparti numerati. Fonte dichiarata: inventario G-60.",
        },
      ],
      unsafe: [
        {
          pageId: "h2-seed-bank",
          paragraph: 0,
          after:
            "La banca dei semi fittizia Germoglio ha 60 scomparti numerati. Fonte dichiarata: inventario G-60.",
        },
      ],
      safeSummary: [
        {
          pageId: "h2-seed-bank",
          before: lockerSummary,
          after: lockerSummary.replace("6 scomparti", "60 scomparti"),
        },
      ],
      unsafeSummary: [
        {
          pageId: "h2-seed-bank",
          before: lockerSummary,
          after:
            "La banca dei semi fittizia Germoglio ha 60 scomparti numerati secondo l'inventario G-60. L'accesso è consentito a tutti secondo il regolamento G-1.",
        },
      ],
      violation: "summary_conditions",
      resolution: "b" as const,
      corrections: [{ pageId: "h2-seed-bank", paragraph: 0 }],
    },
    {
      id: "marionette-residue",
      category: "residue-without-factual-dates",
      pages: [
        page("h2-marionette", "Pulizia della marionetta fittizia Filo", [
          "La marionetta fittizia Filo ha una testa in legno e si pulisce con un panno morbido asciutto. Istruzione originale F-8: «Testa in legno; usare un panno morbido asciutto per la pulizia».",
          "Il consolidatore ha esaminato questa pagina, controllato i collegamenti e terminato la manutenzione automatica.",
        ]),
      ],
      kind: "remove_maintenance_residue" as const,
      goal: "Rimuovi soltanto il resoconto dell'attività del consolidatore preservando materiali, istruzioni di pulizia e fonte della marionetta.",
      safe: [{ pageId: "h2-marionette", paragraph: 1, after: "" }],
      unsafe: [
        {
          pageId: "h2-marionette",
          paragraph: 1,
          after:
            "Il consolidatore ha completato la pulizia di questa pagina. Nuovo punto aperto: il proprietario deve confermare quale panno usare.",
        },
      ],
      violation: "no_human_work",
    },
    {
      id: "game-loan-transition",
      category: "temporal-effective-date",
      pages: [
        page("h2-game-loan", "Limiti attuali del prestito Cubo", [
          loanOriginal,
        ]),
        page("h2-game-circular", "Testo originale della circolare C-70", [
          "Circolare originale C-70: «Fino al 31 agosto 2026 incluso il centro giochi Cubo ammette al massimo 2 giochi in prestito contemporaneamente. Dal 1 settembre 2026 il massimo diventa 5 giochi contemporaneamente. La durata massima del singolo prestito resta 14 giorni».",
        ]),
      ],
      kind: "reconcile" as const,
      goal: "Correggi la quota presentata come attuale esplicitando la successione documentata: 2 giochi fino al 31 agosto 2026 e 5 dal 1 settembre 2026. Mantieni invariata la durata massima del prestito.",
      safe: [
        {
          pageId: "h2-game-loan",
          paragraph: 0,
          after:
            "Il centro giochi fittizio Cubo permetteva al massimo 2 giochi in prestito contemporaneamente fino al 31 agosto 2026 incluso. Dal 1 settembre 2026 ne permette al massimo 5. Ogni prestito dura al massimo 14 giorni. Fonte: circolare C-70.",
        },
      ],
      unsafe: [
        {
          pageId: "h2-game-loan",
          paragraph: 0,
          after:
            "Il centro giochi fittizio Cubo permetteva al massimo 2 giochi in prestito contemporaneamente fino al 31 luglio 2026 incluso. Dal 1 agosto 2026 ne permette al massimo 5. Ogni prestito dura al massimo 14 giorni. Fonte: circolare C-70.",
        },
      ],
      violation: "time",
      resolution: "temporal" as const,
      corrections: [{ pageId: "h2-game-loan", paragraph: 0 }],
    },
  ].flatMap(pair);
  const procedurePages = [
    page("h2-procedure-original", "Istruzione originale di imballaggio R-1", [
      "L'istruzione originale fittizia R-1 prescrive di sigillare gli involucri con nastro di carta. Questa pagina conserva il testo della versione originaria R-1.",
    ]),
    page("h2-procedure-replacement", "Istruzione di imballaggio R-2", [
      "Testo originale integrale dell'istruzione fittizia R-2: «L'istruzione R-2 sostituisce integralmente la precedente istruzione R-1. Gli involucri si sigillano con una fascetta riutilizzabile». R-1 e R-2 sono identificativi distinti di queste due versioni della stessa procedura.",
    ]),
  ];
  const directedLinks: CalibrationCase[] = [true, false].map(
    (expectedAccept) => {
      const snapshot = buildSnapshot(
        procedurePages,
        "2026-09-25T00:00:00.000Z",
      );
      const id = `holdout-v2-procedure-supersession-${expectedAccept ? "safe" : "unsafe"}`;
      const link = {
        sourceId: expectedAccept
          ? "h2-procedure-replacement"
          : "h2-procedure-original",
        targetId: expectedAccept
          ? "h2-procedure-original"
          : "h2-procedure-replacement",
        type: "supersedes" as const,
      };
      return {
        id,
        scenarioId: "v2-procedure-supersession",
        split: "holdout",
        category: "typed-link-replacement-direction",
        snapshot,
        plan: {
          id: `plan-${id}`,
          kind: "add_link",
          findingIds: [`finding-${id}`],
          targetPageIds: [link.sourceId],
          targetUnitIds: [],
          evidenceUnitIds: snapshot.units.map((unit) => unit.id),
          readSet: snapshot.pages.map(({ id: pageId, version }) => ({
            pageId,
            version,
          })),
          goal: "Registra con una relazione supersedes la sostituzione documentata tra le due versioni esatte dell'istruzione di imballaggio.",
          link,
        },
        draft: {
          noChange: false,
          patches: [],
          links: [{ ...link, label: "" }],
        },
        expectedAccept,
        ...(!expectedAccept ? { expectedViolation: "link_direction" } : {}),
      };
    },
  );
  return [...textual, ...directedLinks];
}
