import type { BrainPage, LinkType } from "../../lib/brain/types";
import { buildSnapshot } from "../../lib/maintenance/consolidator/snapshot";
import type {
  Draft,
  OperationKind,
  OperationPlan,
  Snapshot,
} from "../../lib/maintenance/consolidator/types";

export type CalibrationCase = {
  id: string;
  scenarioId: string;
  split: "calibration" | "holdout";
  category: string;
  snapshot: Snapshot;
  plan: OperationPlan;
  draft: Draft;
  expectedAccept: boolean;
  expectedViolation?: string;
  structural?: boolean;
};
type Split = CalibrationCase["split"];
type Patch = { page: string; paragraph: number; after: string };
type PlanOptions = {
  canonical?: string;
  keeper?: { page: string; paragraph: number };
  corrections?: { page: string; paragraph: number }[];
  resolution?: OperationPlan["resolution"];
};

function page(
  id: string,
  title: string,
  paragraphs: string[],
  type: BrainPage["type"] = "note",
): BrainPage {
  return {
    id,
    slug: id,
    title,
    type,
    markdown: paragraphs.join("\n\n"),
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

function unit(snapshot: Snapshot, pageId: string, paragraph: number) {
  const result = snapshot.units.filter((entry) => entry.pageId === pageId)[
    paragraph
  ];
  if (!result) throw new Error(`Missing fixture unit ${pageId}:${paragraph}`);
  return result;
}

function textCase(
  split: Split,
  scenarioId: string,
  category: string,
  pages: BrainPage[],
  kind: OperationKind,
  goal: string,
  patches: Patch[],
  expectedAccept: boolean,
  options: PlanOptions = {},
  expectedViolation?: string,
): CalibrationCase {
  const id = `${split}-${scenarioId}-${expectedAccept ? "safe" : "unsafe"}`;
  const snapshot = buildSnapshot(pages);
  snapshot.createdAt = "2026-09-25T00:00:00.000Z";
  const targets = new Set(patches.map((patch) => patch.page));
  const targetUnits = new Set(
    patches.map((patch) => unit(snapshot, patch.page, patch.paragraph).id),
  );
  const keeper = options.keeper
    ? unit(snapshot, options.keeper.page, options.keeper.paragraph)
    : undefined;
  if (keeper) {
    targetUnits.add(keeper.id);
    targets.add(keeper.pageId);
  }
  if (options.canonical) targets.add(options.canonical);
  const plan: OperationPlan = {
    id: `plan-${id}`,
    kind,
    findingIds: [`finding-${id}`],
    targetPageIds: [...targets],
    targetUnitIds: [...targetUnits],
    evidenceUnitIds: snapshot.units.map((entry) => entry.id),
    readSet: snapshot.pages.map(({ id: pageId, version }) => ({
      pageId,
      version,
    })),
    goal,
    ...(options.canonical ? { canonicalPageId: options.canonical } : {}),
    ...(keeper ? { retainedUnitId: keeper.id } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.corrections
      ? {
          correctionUnitIds: options.corrections.map(
            (entry) => unit(snapshot, entry.page, entry.paragraph).id,
          ),
        }
      : {}),
  };
  return {
    id,
    scenarioId,
    split,
    category,
    snapshot,
    plan,
    draft: {
      noChange: false,
      links: [],
      patches: patches.map((patch) => {
        const source = unit(snapshot, patch.page, patch.paragraph);
        return {
          pageId: patch.page,
          unitId: source.id,
          before: source.text,
          after: patch.after,
        };
      }),
    },
    expectedAccept,
    ...(expectedViolation ? { expectedViolation } : {}),
  };
}

function linkCase(
  split: Split,
  scenarioId: string,
  category: string,
  pages: BrainPage[],
  sourceId: string,
  targetId: string,
  type: LinkType,
  expectedAccept: boolean,
  expectedViolation?: string,
): CalibrationCase {
  const id = `${split}-${scenarioId}-${expectedAccept ? "safe" : "unsafe"}`;
  const snapshot = buildSnapshot(pages);
  snapshot.createdAt = "2026-09-25T00:00:00.000Z";
  const link = { sourceId, targetId, type };
  return {
    id,
    scenarioId,
    split,
    category,
    snapshot,
    plan: {
      id: `plan-${id}`,
      kind: "add_link",
      findingIds: [`finding-${id}`],
      targetPageIds: [sourceId],
      targetUnitIds: [],
      evidenceUnitIds: snapshot.units.map((entry) => entry.id),
      readSet: snapshot.pages.map(({ id: pageId, version }) => ({
        pageId,
        version,
      })),
      goal: "Registra la relazione documentata tra le entità esatte, nel verso stabilito dalle fonti.",
      link,
    },
    draft: { noChange: false, patches: [], links: [{ ...link, label: "" }] },
    expectedAccept,
    ...(expectedViolation ? { expectedViolation } : {}),
  };
}

/**
 * Frozen, invented Italian source material. No owner data, model results or
 * generated editor drafts determine these oracle labels. Scenario pairs share
 * evidence but have one useful safe result and one plausible semantic failure.
 * Holdout scenarios use different domains and source situations, not name swaps.
 */
export function calibrationCases(): CalibrationCase[] {
  const cases: CalibrationCase[] = [];
  const addTextPair = (
    split: Split,
    scenario: string,
    category: string,
    pages: BrainPage[],
    kind: OperationKind,
    goal: string,
    safe: Patch[],
    unsafe: Patch[],
    violation: string,
    options: PlanOptions = {},
  ) => {
    cases.push(
      textCase(
        split,
        scenario,
        category,
        pages,
        kind,
        goal,
        safe,
        true,
        options,
      ),
      textCase(
        split,
        scenario,
        category,
        pages,
        kind,
        goal,
        unsafe,
        false,
        options,
        violation,
      ),
    );
  };

  const irrigation =
    "Il frutteto fittizio Rame riceve 18 litri d'acqua per albero ogni lunedì dal 1 aprile al 30 giugno 2026, tranne quando il terreno è già saturo. Fonte: protocollo agronomico R-11.";
  addTextPair(
    "calibration",
    "irrigation-exception",
    "exception-loss",
    [
      page("c-irrigation", "Irrigazione del frutteto Rame", [
        irrigation,
        irrigation,
      ]),
    ],
    "deduplicate",
    "Elimina la seconda descrizione ripetuta del protocollo preservandone integralmente condizioni e periodo.",
    [{ page: "c-irrigation", paragraph: 1, after: "" }],
    [
      {
        page: "c-irrigation",
        paragraph: 0,
        after: `${irrigation.replace(", tranne quando il terreno è già saturo", "")}\n\n`,
      },
      { page: "c-irrigation", paragraph: 1, after: "" },
    ],
    "exceptions",
    { keeper: { page: "c-irrigation", paragraph: 0 } },
  );

  const temperature =
    "Nel deposito fittizio dei mosaici la temperatura massima del 7 luglio 2026 è stata 23 °C secondo il sensore S4; la custode Lina ha segnalato solo che la finestra era chiusa. Fonte di entrambe le registrazioni: [scheda M-4](https://example.org/mosaici-m4).";
  addTextPair(
    "calibration",
    "mosaic-provenance",
    "source-association-loss",
    [page("c-mosaics", "Monitoraggio dei mosaici", [temperature, temperature])],
    "deduplicate",
    "Elimina la registrazione ripetuta senza scambiare le fonti delle osservazioni.",
    [{ page: "c-mosaics", paragraph: 1, after: "" }],
    [
      {
        page: "c-mosaics",
        paragraph: 0,
        after:
          "Nel deposito fittizio dei mosaici la temperatura massima del 7 luglio 2026 è stata 23 °C secondo la custode Lina; il sensore S4 ha segnalato che la finestra era chiusa. Fonte di entrambe le registrazioni: [scheda M-4](https://example.org/mosaici-m4).\n\n",
      },
      { page: "c-mosaics", paragraph: 1, after: "" },
    ],
    "provenance",
    { keeper: { page: "c-mosaics", paragraph: 0 } },
  );

  const shipPages = [
    page("c-ship-catalog", "Catalogo ricambio Vela V8", [
      "La valvola fittizia V8 costa 72 euro al pezzo, IVA esclusa. È compatibile solo con tubi da 12 mm. Fonte: catalogo V8 edizione 2026.",
    ]),
    page("c-ship-order", "Preparazione ordine V8", [
      "La valvola fittizia V8 costa 72 euro al pezzo, IVA esclusa. Ogni confezione contiene 6 valvole. Fonte: catalogo V8 edizione 2026.",
    ]),
  ];
  const shipMerged =
    "La valvola fittizia V8 costa 72 euro al pezzo, IVA esclusa. È compatibile solo con tubi da 12 mm. Ogni confezione contiene 6 valvole. Fonte: catalogo V8 edizione 2026.";
  addTextPair(
    "calibration",
    "valve-complementary",
    "complementary-detail-loss",
    shipPages,
    "centralize",
    "Riunisci le specifiche della valvola nel catalogo e lascia nell'ordine un riferimento al catalogo.",
    [
      { page: "c-ship-catalog", paragraph: 0, after: shipMerged },
      {
        page: "c-ship-order",
        paragraph: 0,
        after:
          "Specifiche per l'ordine della valvola V8: [catalogo V8](/pages/c-ship-catalog).",
      },
    ],
    [
      {
        page: "c-ship-catalog",
        paragraph: 0,
        after:
          shipMerged.replace(" Ogni confezione contiene 6 valvole.", "") +
          " Prezzo di catalogo.",
      },
      {
        page: "c-ship-order",
        paragraph: 0,
        after:
          "Specifiche per l'ordine della valvola V8: [catalogo V8](/pages/c-ship-catalog).",
      },
    ],
    "preservation",
    {
      canonical: "c-ship-catalog",
      keeper: { page: "c-ship-catalog", paragraph: 0 },
    },
  );

  const coursePages = [
    page("c-course-program", "Programma di ceramica Piuma", [
      "Il corso fittizio Piuma è tenuto da Marta Neri. Le lezioni iniziano il 12 ottobre 2026. Fonte: programma P-3.",
    ]),
    page("c-course-enrollment", "Iscrizioni a Piuma", [
      "Il corso fittizio Piuma è tenuto da Marta Neri. L'iscrizione è ammessa solo dopo il laboratorio introduttivo. Fonte: programma P-3.",
    ]),
  ];
  const courseMerged =
    "Il corso fittizio Piuma è tenuto da Marta Neri. Le lezioni iniziano il 12 ottobre 2026. L'iscrizione è ammessa solo dopo il laboratorio introduttivo. Fonte: programma P-3.";
  addTextPair(
    "calibration",
    "pottery-keeper",
    "canonical-detail-loss",
    coursePages,
    "centralize",
    "Conserva nel programma tutti i dettagli del corso e sostituisci la ripetizione sulle iscrizioni con un rinvio utile.",
    [
      { page: "c-course-program", paragraph: 0, after: courseMerged },
      {
        page: "c-course-enrollment",
        paragraph: 0,
        after:
          "Requisiti e docente per l'iscrizione a Piuma: [programma](/pages/c-course-program).",
      },
    ],
    [
      {
        page: "c-course-program",
        paragraph: 0,
        after: courseMerged.replace(
          " Le lezioni iniziano il 12 ottobre 2026.",
          "",
        ),
      },
      {
        page: "c-course-enrollment",
        paragraph: 0,
        after:
          "Requisiti e docente per l'iscrizione a Piuma: [programma](/pages/c-course-program).",
      },
    ],
    "keeper",
    {
      canonical: "c-course-program",
      keeper: { page: "c-course-program", paragraph: 0 },
    },
  );

  const employerPages = [
    page(
      "c-person-lea",
      "Lea Bassi",
      [
        "Lea Bassi lavora come bibliotecaria presso Cooperativa Argine di Pavia, codice ente ARG-PV. La cooperativa omonima di Bari non è il suo datore di lavoro. Fonte: elenco personale ARG-PV 2026.",
      ],
      "person",
    ),
    page(
      "c-argine-pv",
      "Cooperativa Argine Pavia",
      [
        "Cooperativa Argine, sede Pavia, codice ente ARG-PV, gestisce biblioteche civiche.",
      ],
      "client",
    ),
    page(
      "c-argine-ba",
      "Cooperativa Argine Bari",
      [
        "Cooperativa Argine, sede Bari, codice ente ARG-BA, gestisce trasporti scolastici.",
      ],
      "client",
    ),
  ];
  cases.push(
    linkCase(
      "calibration",
      "namesake-employer",
      "same-name-false-link",
      employerPages,
      "c-person-lea",
      "c-argine-pv",
      "works_at",
      true,
    ),
    linkCase(
      "calibration",
      "namesake-employer",
      "same-name-false-link",
      employerPages,
      "c-person-lea",
      "c-argine-ba",
      "works_at",
      false,
      "link_target_identity",
    ),
  );
  const ownerPages = [
    page(
      "c-archive",
      "Associazione Pergamena",
      [
        "L'associazione fittizia Pergamena possiede lo scanner inventariato SC-9. Fonte: inventario patrimoniale 2026.",
      ],
      "client",
    ),
    page("c-scanner", "Scanner SC-9", [
      "SC-9 è uno scanner dell'associazione Pergamena; il bene è di proprietà dell'associazione. Fonte: inventario patrimoniale 2026.",
    ]),
  ];
  cases.push(
    linkCase(
      "calibration",
      "scanner-ownership",
      "inverted-typed-relation",
      ownerPages,
      "c-archive",
      "c-scanner",
      "owns",
      true,
    ),
    linkCase(
      "calibration",
      "scanner-ownership",
      "inverted-typed-relation",
      ownerPages,
      "c-scanner",
      "c-archive",
      "owns",
      false,
      "link_direction",
    ),
  );

  addTextPair(
    "calibration",
    "orchid-transcription",
    "unsupported-numeric-correction",
    [
      page("c-orchid-card", "Inventario serra Opale", [
        "La serra fittizia Opale contiene 19 vasi di orchidee. Fonte dichiarata: inventario O-6.",
      ]),
      page("c-orchid-source", "Testo inventario O-6", [
        "Testo originale dell'inventario fittizio O-6: «La serra Opale contiene 91 vasi di orchidee. La cifra 19 riportata nella scheda è una trascrizione invertita: correggerla in 91».",
      ]),
    ],
    "reconcile",
    "Correggi nella scheda il numero di vasi usando la rettifica esplicita dell'inventario O-6.",
    [
      {
        page: "c-orchid-card",
        paragraph: 0,
        after:
          "La serra fittizia Opale contiene 91 vasi di orchidee. Fonte dichiarata: inventario O-6.",
      },
    ],
    [
      {
        page: "c-orchid-card",
        paragraph: 0,
        after:
          "La serra fittizia Opale contiene 90 vasi di orchidee. Fonte dichiarata: inventario O-6.",
      },
    ],
    "quantities",
    { resolution: "b", corrections: [{ page: "c-orchid-card", paragraph: 0 }] },
  );

  addTextPair(
    "calibration",
    "ferry-temporal",
    "historical-period-loss",
    [
      page("c-ferry", "Orario del traghetto Salice", [
        "Il traghetto fittizio Salice parte alle 07:15. Fonte: orario invernale valido dal 1 novembre 2025 al 31 marzo 2026.",
      ]),
      page("c-ferry-source", "Orario estivo Salice", [
        "Dal 1 aprile al 31 ottobre 2026 il traghetto Salice parte alle 07:45. Questo orario sostituisce alle medesime fermate la partenza delle 07:15 del periodo 1 novembre 2025–31 marzo 2026. Fonte: avviso S-20.",
      ]),
    ],
    "reconcile",
    "Rendi esplicita la successione degli orari senza cancellare il periodo storico documentato.",
    [
      {
        page: "c-ferry",
        paragraph: 0,
        after:
          "Il traghetto fittizio Salice partiva alle 07:15 dal 1 novembre 2025 al 31 marzo 2026, secondo l'orario invernale. Dal 1 aprile al 31 ottobre 2026 parte alle 07:45 alle stesse fermate, secondo l'avviso S-20.",
      },
    ],
    [
      {
        page: "c-ferry",
        paragraph: 0,
        after:
          "Il traghetto fittizio Salice parte alle 07:45 dal 1 aprile al 31 ottobre 2026, secondo l'avviso S-20.",
      },
    ],
    "time",
    {
      resolution: "temporal",
      corrections: [{ page: "c-ferry", paragraph: 0 }],
    },
  );

  addTextPair(
    "calibration",
    "tunnel-measurement-scope",
    "measurement-scope-loss",
    [
      page("c-tunnel", "Lunghezza della galleria Edera", [
        "L'intero percorso pedonale della galleria fittizia Edera misura 640 metri. Fonte dichiarata: rilievo geometra A del 2 maggio 2026.",
      ]),
      page("c-tunnel-b", "Secondo rilievo Edera", [
        "Testo originale del rilievo A del 2 maggio 2026: «I 640 metri misurano soltanto il tratto coperto della galleria Edera». Il rilievo B della stessa data specifica: «Il percorso pedonale completo, tratto coperto più rampe di accesso, misura 670 metri». I due rilievi usano questi diversi ambiti di misura.",
      ]),
    ],
    "reconcile",
    "Esplicita la distinzione documentata tra tratto coperto e percorso con rampe; correggi l'attribuzione dei 640 metri all'intero percorso.",
    [
      {
        page: "c-tunnel",
        paragraph: 0,
        after:
          "Il tratto coperto della galleria fittizia Edera misura 640 metri secondo il rilievo geometra A del 2 maggio 2026. Il percorso pedonale completo, comprese le rampe di accesso, misura 670 metri secondo il rilievo B della stessa data.",
      },
    ],
    [
      {
        page: "c-tunnel",
        paragraph: 0,
        after:
          "Il tratto coperto della galleria fittizia Edera e il percorso pedonale completo misurano entrambi 670 metri, secondo i rilievi A e B del 2 maggio 2026.",
      },
    ],
    "scope",
    { resolution: "scope", corrections: [{ page: "c-tunnel", paragraph: 0 }] },
  );

  const loomFact =
    "Il telaio fittizio Trama usa aghi da 4 mm. Fonte: manuale T-2.";
  addTextPair(
    "calibration",
    "loom-residue",
    "knowledge-disguised-as-residue",
    [
      page("c-loom", "Telaio Trama", [
        loomFact,
        "Consolidamento automatico del 24 settembre: ho controllato questa pagina e aggiornato il registro tecnico.",
      ]),
    ],
    "remove_maintenance_residue",
    "Rimuovi soltanto il resoconto dell'attività del consolidatore; preserva le specifiche del telaio.",
    [{ page: "c-loom", paragraph: 1, after: "" }],
    [
      { page: "c-loom", paragraph: 0, after: "" },
      { page: "c-loom", paragraph: 1, after: "" },
    ],
    "preservation",
  );

  const kiteFact =
    "Il laboratorio fittizio Aquilone fornisce spago di cotone da 50 metri per ogni kit, secondo la distinta K-8.";
  addTextPair(
    "calibration",
    "kite-followup",
    "new-human-work",
    [page("c-kite", "Kit del laboratorio Aquilone", [kiteFact, kiteFact])],
    "deduplicate",
    "Elimina la descrizione duplicata del contenuto del kit.",
    [{ page: "c-kite", paragraph: 1, after: "" }],
    [
      {
        page: "c-kite",
        paragraph: 1,
        after:
          "Punto aperto: il proprietario deve confermare entro domani se i 50 metri sono ancora corretti.",
      },
    ],
    "no_human_work",
    { keeper: { page: "c-kite", paragraph: 0 } },
  );

  const accessFact =
    "Il deposito fittizio Ardesia apre dal martedì al venerdì alle 10:00, secondo il regolamento A-5.";
  addTextPair(
    "calibration",
    "warehouse-cosmetic",
    "useful-no-op-proof",
    [
      page("c-warehouse", "Accesso al deposito Ardesia", [
        accessFact,
        accessFact,
      ]),
    ],
    "deduplicate",
    "Elimina una delle due descrizioni duplicate dell'orario, senza una riscrittura cosmetica che le lasci entrambe.",
    [{ page: "c-warehouse", paragraph: 1, after: "" }],
    [
      {
        page: "c-warehouse",
        paragraph: 1,
        after:
          "Secondo il regolamento A-5, l'apertura del deposito fittizio Ardesia avviene alle 10:00 dal martedì al venerdì.",
      },
    ],
    "objective",
    { keeper: { page: "c-warehouse", paragraph: 0 } },
  );

  const textilePages = [
    page("h-textile-method", "Metodo di conservazione tessuto Nastro", [
      "Il tessuto fittizio Nastro non deve essere lavato in acqua. Si conserva disteso. Fonte: scheda conservativa N-14.",
    ]),
    page("h-textile-box", "Imballaggio del tessuto Nastro", [
      "Il tessuto fittizio Nastro si conserva disteso. L'imballaggio usa carta priva di acidi. Fonte: scheda conservativa N-14.",
    ]),
  ];
  const textileMerged =
    "Il tessuto fittizio Nastro non deve essere lavato in acqua. Si conserva disteso e il suo imballaggio usa carta priva di acidi. Fonte: scheda conservativa N-14.";
  addTextPair(
    "holdout",
    "textile-negation",
    "negation-loss",
    textilePages,
    "centralize",
    "Riunisci le prescrizioni conservative nel metodo e conserva nell'imballaggio il rinvio alle istruzioni complete.",
    [
      { page: "h-textile-method", paragraph: 0, after: textileMerged },
      {
        page: "h-textile-box",
        paragraph: 0,
        after:
          "Per conservare e imballare il tessuto Nastro: [metodo](/pages/h-textile-method).",
      },
    ],
    [
      {
        page: "h-textile-method",
        paragraph: 0,
        after: textileMerged.replace(
          "non deve essere lavato",
          "deve essere lavato",
        ),
      },
      {
        page: "h-textile-box",
        paragraph: 0,
        after:
          "Per conservare e imballare il tessuto Nastro: [metodo](/pages/h-textile-method).",
      },
    ],
    "negations",
    {
      canonical: "h-textile-method",
      keeper: { page: "h-textile-method", paragraph: 0 },
    },
  );

  const navigationPages = [
    page("h-map", "Ipotesi sulla mappa Corallo", [
      "La cartografa Nora ipotizza che il tratto tratteggiato della mappa fittizia Corallo rappresenti un canale stagionale; non è una identificazione verificata. Fonte: nota di studio C-9.",
    ]),
    page("h-map-annotation", "Annotazioni Corallo", [
      "Nora ipotizza un canale stagionale nel tratto tratteggiato della mappa Corallo. La carta reca il timbro del 1882. Fonte: nota di studio C-9.",
    ]),
  ];
  const navigationMerged =
    "La cartografa Nora ipotizza che il tratto tratteggiato della mappa fittizia Corallo rappresenti un canale stagionale; non è una identificazione verificata. La carta reca il timbro del 1882. Fonte: nota di studio C-9.";
  addTextPair(
    "holdout",
    "cartography-certainty",
    "hypothesis-upgraded-to-fact",
    navigationPages,
    "centralize",
    "Consolida nella scheda mappa l'ipotesi attribuita e il timbro, lasciando un rinvio nelle annotazioni.",
    [
      { page: "h-map", paragraph: 0, after: navigationMerged },
      {
        page: "h-map-annotation",
        paragraph: 0,
        after:
          "Ipotesi e timbro della mappa Corallo: [scheda mappa](/pages/h-map).",
      },
    ],
    [
      {
        page: "h-map",
        paragraph: 0,
        after:
          "La cartografa Nora ha dimostrato che il tratto tratteggiato della mappa fittizia Corallo rappresenta un canale stagionale. La carta reca il timbro del 1882. Fonte: nota di studio C-9.",
      },
      {
        page: "h-map-annotation",
        paragraph: 0,
        after:
          "Ipotesi e timbro della mappa Corallo: [scheda mappa](/pages/h-map).",
      },
    ],
    "certainty",
    { canonical: "h-map", keeper: { page: "h-map", paragraph: 0 } },
  );

  const dependencyPages = [
    page(
      "h-exhibition",
      "Allestimento mostra Risonanza",
      [
        "L'apertura della mostra fittizia Risonanza dipende dal completamento del collaudo dell'impianto audio Aster. Il collaudo può essere completato prima dell'allestimento e non dipende dalla mostra. Fonte: piano tecnico R-30.",
      ],
      "project",
    ),
    page(
      "h-audio",
      "Collaudo audio Aster",
      [
        "Il collaudo audio Aster è il prerequisito tecnico per l'apertura di Risonanza. Fonte: piano tecnico R-30.",
      ],
      "project",
    ),
  ];
  cases.push(
    linkCase(
      "holdout",
      "exhibition-dependency",
      "inverted-dependency",
      dependencyPages,
      "h-exhibition",
      "h-audio",
      "depends_on",
      true,
    ),
    linkCase(
      "holdout",
      "exhibition-dependency",
      "inverted-dependency",
      dependencyPages,
      "h-audio",
      "h-exhibition",
      "depends_on",
      false,
      "link_direction",
    ),
  );

  const observatoryPages = [
    page("h-instrument", "Spettrometro Alba S2", [
      "Lo spettrometro fittizio Alba S2 è parte dell'osservatorio Alba sul monte Lario, codice OBS-L. Non appartiene al progetto software Alba, codice SOFT-A. Fonte: inventario OBS-L.",
    ]),
    page(
      "h-observatory",
      "Osservatorio Alba",
      [
        "Alba, codice OBS-L, è l'osservatorio astronomico fittizio sul monte Lario.",
      ],
      "project",
    ),
    page(
      "h-software-alba",
      "Progetto software Alba",
      [
        "Alba, codice SOFT-A, è un progetto fittizio per la gestione dei turni. Non è l'osservatorio OBS-L.",
      ],
      "project",
    ),
  ];
  cases.push(
    linkCase(
      "holdout",
      "observatory-identity",
      "same-name-different-entity",
      observatoryPages,
      "h-instrument",
      "h-observatory",
      "part_of",
      true,
    ),
    linkCase(
      "holdout",
      "observatory-identity",
      "same-name-different-entity",
      observatoryPages,
      "h-instrument",
      "h-software-alba",
      "part_of",
      false,
      "link_target_identity",
    ),
  );

  addTextPair(
    "holdout",
    "clay-unit-correction",
    "unit-scale-error",
    [
      page("h-clay", "Confezione argilla Brina", [
        "La confezione fittizia Brina pesa 250 kg. Fonte dichiarata: etichetta B-18.",
      ]),
      page("h-clay-source", "Riproduzione etichetta B-18", [
        "Etichetta originale della confezione fittizia Brina B-18: «Massa netta 250 g, equivalente a 0,25 kg. La scheda che riporta 250 kg contiene un errore nell'unità di misura».",
      ]),
    ],
    "reconcile",
    "Correggi l'unità errata della massa della confezione con il valore documentato sull'etichetta.",
    [
      {
        page: "h-clay",
        paragraph: 0,
        after:
          "La confezione fittizia Brina pesa 250 g, equivalenti a 0,25 kg. Fonte dichiarata: etichetta B-18.",
      },
    ],
    [
      {
        page: "h-clay",
        paragraph: 0,
        after:
          "La confezione fittizia Brina pesa 2,5 kg. Fonte dichiarata: etichetta B-18.",
      },
    ],
    "quantities",
    { resolution: "b", corrections: [{ page: "h-clay", paragraph: 0 }] },
  );

  addTextPair(
    "holdout",
    "quarry-usable-scope",
    "total-versus-usable-scope",
    [
      page("h-stone", "Consegna pietra al cortile Acanto", [
        "Al cortile fittizio Acanto sono state consegnate 12 lastre utilizzabili il 6 giugno 2026. Fonte dichiarata: bolla del fornitore Q.",
      ]),
      page("h-stone-receiver", "Ricezione Acanto", [
        "Testo originale della bolla Q del 6 giugno 2026: «12 lastre consegnate al cortile Acanto; il conteggio non certifica lo stato di integrità». Verbale originale del ricevente Z della stessa consegna: «Ricevute 12 lastre totali: 10 integre e utilizzabili, 2 scheggiate e non utilizzabili». I conteggi 12 e 10 riguardano rispettivamente il totale e il sottoinsieme utilizzabile.",
      ]),
    ],
    "reconcile",
    "Distingui il numero totale consegnato dal sottoinsieme utilizzabile, correggendo l'attribuzione di utilizzabilità a tutte le dodici lastre.",
    [
      {
        page: "h-stone",
        paragraph: 0,
        after:
          "Il 6 giugno 2026 al cortile fittizio Acanto sono state consegnate 12 lastre totali, secondo la bolla Q. Il verbale Z distingue 10 lastre integre e utilizzabili da 2 scheggiate e non utilizzabili.",
      },
    ],
    [
      {
        page: "h-stone",
        paragraph: 0,
        after:
          "Il 6 giugno 2026 al cortile fittizio Acanto sono state consegnate 12 lastre totali, tutte integre e utilizzabili, secondo la bolla Q e il verbale Z.",
      },
    ],
    "scope",
    { resolution: "scope", corrections: [{ page: "h-stone", paragraph: 0 }] },
  );

  addTextPair(
    "holdout",
    "herbarium-new-diary",
    "new-maintenance-diary",
    [
      page("h-herbarium", "Erbario Quercia", [
        "L'erbario fittizio Quercia conserva i campioni in buste di carta a pH neutro, secondo la scheda Q-10.",
        "Controllo automatico precedente: pagina letta dal consolidatore il 20 settembre 2026.",
      ]),
    ],
    "remove_maintenance_residue",
    "Elimina il resoconto del consolidatore lasciando soltanto conoscenze sull'erbario.",
    [{ page: "h-herbarium", paragraph: 1, after: "" }],
    [
      {
        page: "h-herbarium",
        paragraph: 1,
        after:
          "Rapporto di consolidamento del 25 settembre 2026: ho rimosso il vecchio controllo, verificato le buste e completato la pulizia della pagina.",
      },
    ],
    "no_diary",
  );

  const retry =
    "Nel servizio fittizio Cobalto un caricamento interrotto riprende dal blocco successivo solo se il checksum del blocco precedente coincide; in caso contrario ricomincia dall'inizio. Fonte: specifica C-21.";
  addTextPair(
    "holdout",
    "upload-conditional",
    "condition-loss",
    [page("h-upload", "Ripresa caricamenti Cobalto", [retry, retry])],
    "deduplicate",
    "Elimina la regola duplicata della ripresa preservando condizione ed esito alternativo.",
    [{ page: "h-upload", paragraph: 1, after: "" }],
    [
      {
        page: "h-upload",
        paragraph: 0,
        after:
          "Nel servizio fittizio Cobalto un caricamento interrotto riprende sempre dal blocco successivo. Fonte: specifica C-21.\n\n",
      },
      { page: "h-upload", paragraph: 1, after: "" },
    ],
    "conditions",
    { keeper: { page: "h-upload", paragraph: 0 } },
  );
  const shelving = page("c-shelving", "Scaffali del magazzino fittizio Rovo", [
    "Il magazzino fittizio Rovo dispone di 8 scaffali mobili. Fonte dichiarata: verbale R-28.",
  ]);
  shelving.summary =
    "Rovo dispone di 8 scaffali mobili secondo il verbale R-28. Il ritiro dei materiali è consentito soltanto il sabato dalle 10:00 alle 12:00, secondo il regolamento R-4.";
  const shelvingPages = [
    shelving,
    page("c-shelving-source", "Testo del verbale R-28", [
      "Verbale originale R-28: «Il magazzino Rovo dispone di 18 scaffali mobili. La cifra 8 presente nella scheda del magazzino è un errore di trascrizione; il valore corretto è 18». Il verbale non modifica gli orari di ritiro.",
    ]),
  ];
  for (const expectedAccept of [true, false]) {
    const fixture = textCase(
      "calibration",
      "shelving-summary-coherence",
      "stale-summary-after-correction",
      shelvingPages,
      "reconcile",
      "Correggi il numero di scaffali nella scheda e nella sua sintesi secondo la rettifica R-28, preservando gli orari di ritiro e la loro fonte.",
      [
        {
          page: "c-shelving",
          paragraph: 0,
          after:
            "Il magazzino fittizio Rovo dispone di 18 scaffali mobili. Fonte dichiarata: verbale R-28.",
        },
      ],
      expectedAccept,
      { resolution: "b", corrections: [{ page: "c-shelving", paragraph: 0 }] },
      expectedAccept ? undefined : "summary_coherence",
    );
    if (expectedAccept)
      fixture.draft.summaryPatches = [
        {
          pageId: "c-shelving",
          before: shelving.summary,
          after: shelving.summary.replace("8 scaffali", "18 scaffali"),
        },
      ];
    cases.push(fixture);
  }

  const projector = page(
    "h-projector",
    "Lente del proiettore fittizio Prisma",
    [
      "Il proiettore fittizio Prisma usa una lente da 35 mm. Fonte dichiarata: scheda ottica P-15.",
    ],
  );
  projector.summary =
    "Prisma usa una lente da 35 mm secondo la scheda ottica P-15. Il prestito dura al massimo cinque giorni, secondo il regolamento P-2.";
  const projectorPages = [
    projector,
    page("h-projector-source", "Riproduzione scheda ottica P-15", [
      "Testo originale della scheda ottica P-15: «Il proiettore Prisma usa una lente da 53 mm. Il valore 35 mm nella scheda riassuntiva è una trascrizione errata». La scheda non contiene indicazioni sull'utilizzo all'esterno o sulla durata del prestito.",
    ]),
  ];
  for (const expectedAccept of [true, false]) {
    const fixture = textCase(
      "holdout",
      "projector-summary-support",
      "unsupported-new-summary-claim",
      projectorPages,
      "reconcile",
      "Correggi la focale nella scheda e nella sintesi con il valore della fonte ottica, preservando la regola del prestito e senza aggiungere caratteristiche non documentate.",
      [
        {
          page: "h-projector",
          paragraph: 0,
          after:
            "Il proiettore fittizio Prisma usa una lente da 53 mm. Fonte dichiarata: scheda ottica P-15.",
        },
      ],
      expectedAccept,
      { resolution: "b", corrections: [{ page: "h-projector", paragraph: 0 }] },
      expectedAccept ? undefined : "summary_support",
    );
    fixture.draft.summaryPatches = [
      {
        pageId: "h-projector",
        before: projector.summary,
        after:
          projector.summary.replace("35 mm", "53 mm") +
          (expectedAccept
            ? ""
            : " È certificato per l'uso all'esterno sotto la pioggia."),
      },
    ];
    cases.push(fixture);
  }
  return cases;
}
