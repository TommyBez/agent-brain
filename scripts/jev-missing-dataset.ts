import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrainPage, LinkType } from "../lib/brain/types";
import { evidencePage } from "../lib/maintenance/consolidator/projections";
import {
  BASELINE_PROFILE,
  type PromptTask,
} from "../lib/maintenance/consolidator/prompts";
import { buildSnapshot } from "../lib/maintenance/consolidator/snapshot";
import type {
  ChangeSet,
  EvaluationRequest,
  Json,
  OperationKind,
  OperationPlan,
} from "../lib/maintenance/consolidator/types";
import {
  VERIFICATION_EVIDENCE_RULE,
  verifyChangeSet,
} from "../lib/maintenance/consolidator/verifier";
import { validateDataset } from "./apo/dataset";
import type { Example } from "./apo/types";

/** New fictional sources, authored before any model call. No source from previous APO runs. */
export const MISSING_SOURCES = [
  [
    "Archivio Cobalto",
    "L'archivio Cobalto digitalizza i registri del porto e conserva gli originali nella sala protetta.",
    "I registri portuali sono digitalizzati dall'archivio Cobalto; gli originali rimangono nella sala protetta.",
    "L'archivio Cobalto distrugge tutti gli originali dei registri portuali dopo la scansione.",
    "La consultazione delle mappe nautiche richiede una prenotazione distinta.",
  ],
  [
    "Cooperativa Elicriso",
    "La cooperativa Elicriso raccoglie il miele in vasetti di vetro riutilizzabili.",
    "Per confezionare il miele, la cooperativa Elicriso usa vasetti di vetro destinati al riuso.",
    "La cooperativa Elicriso confeziona il miele esclusivamente in plastica monouso.",
    "Ogni lotto riporta il nome del laboratorio di analisi.",
  ],
  [
    "Centro Ardesia",
    "Il centro Ardesia presta strumenti musicali agli allievi iscritti ai corsi serali.",
    "Gli iscritti ai corsi serali possono prendere strumenti musicali in prestito al centro Ardesia.",
    "Il centro Ardesia non concede strumenti in prestito agli iscritti dei corsi serali.",
    "Le prove del coro si svolgono nella sala al piano superiore.",
  ],
  [
    "Rifugio Bellatrix",
    "Il rifugio Bellatrix prepara pasti senza glutine soltanto su prenotazione.",
    "Al rifugio Bellatrix occorre prenotare per ottenere un pasto privo di glutine.",
    "Il rifugio Bellatrix non richiede alcuna prenotazione per i pasti senza glutine.",
    "L'acqua della cisterna viene controllata ogni settimana.",
  ],
  [
    "Officina Prugnolo",
    "L'officina Prugnolo ripara le biciclette pieghevoli e conserva i ricambi per cinque anni.",
    "Le biciclette pieghevoli vengono riparate da Prugnolo, che tiene disponibili i pezzi per un quinquennio.",
    "L'officina Prugnolo rifiuta le biciclette pieghevoli e non conserva i loro ricambi.",
    "Il banco delle vernici è separato dall'area di montaggio.",
  ],
  [
    "Museo Basalto",
    "Il museo Basalto espone i reperti in ordine cronologico e descrive i restauri nelle didascalie.",
    "L'esposizione del museo Basalto segue la cronologia; le didascalie riportano gli interventi di restauro.",
    "Il museo Basalto non segue alcun ordine cronologico e omette i restauri dalle didascalie.",
    "Il deposito ospita una collezione di strumenti agricoli.",
  ],
  [
    "Orto Albireo",
    "L'orto Albireo distribuisce le cassette di verdura in due punti di ritiro coperti.",
    "Per ritirare le cassette di ortaggi di Albireo sono disponibili due sedi al coperto.",
    "L'orto Albireo consegna le cassette soltanto a domicilio e non ha punti di ritiro.",
    "La raccolta delle erbe aromatiche avviene al mattino.",
  ],
  [
    "Laboratorio Canfora",
    "Il laboratorio Canfora usa acqua distillata per lavare le lenti prima dell'ispezione.",
    "Prima di ispezionarle, Canfora lava le lenti con acqua distillata.",
    "Il laboratorio Canfora ispeziona le lenti senza lavarle e non usa acqua distillata.",
    "Le custodie sono numerate per identificare il lotto.",
  ],
  [
    "Teatro Ematite",
    "Il teatro Ematite offre visite tattili del palco prima degli spettacoli accessibili.",
    "Gli spettacoli accessibili di Ematite sono preceduti da visite del palco basate sul tatto.",
    "Il teatro Ematite vieta le visite tattili del palco prima di ogni spettacolo.",
    "Le scenografie vengono conservate in un capannone esterno.",
  ],
  [
    "Scuola Gabbiano Rosso",
    "La scuola Gabbiano Rosso insegna ceramica con forni elettrici e argilla locale.",
    "Nei corsi di ceramica del Gabbiano Rosso si impiegano argilla del territorio e forni elettrici.",
    "La scuola Gabbiano Rosso usa soltanto forni a legna e argilla importata.",
    "Il laboratorio di smaltatura ha un impianto di aspirazione autonomo.",
  ],
  [
    "Consorzio Iperico",
    "Il consorzio Iperico condivide i macchinari agricoli mediante un calendario pubblico.",
    "I macchinari agricoli di Iperico vengono prenotati attraverso un calendario visibile a tutti i soci.",
    "Il consorzio Iperico vieta la condivisione dei macchinari e non pubblica prenotazioni.",
    "L'officina mobile visita i campi durante la stagione della raccolta.",
  ],
  [
    "Biblioteca Lapislazzuli",
    "La biblioteca Lapislazzuli conserva gli audiolibri su dispositivi prestabili senza connessione.",
    "Gli audiolibri di Lapislazzuli si ascoltano anche senza rete sui dispositivi concessi in prestito.",
    "La biblioteca Lapislazzuli permette gli audiolibri soltanto in streaming e non presta dispositivi.",
    "Il catalogo dei manoscritti include una descrizione della rilegatura.",
  ],
  [
    "Palestra Malachite",
    "La palestra Malachite separa gli allenamenti dei principianti dalle gare agonistiche.",
    "A Malachite i principianti si allenano in sessioni distinte rispetto alle competizioni agonistiche.",
    "La palestra Malachite ammette i principianti esclusivamente durante le gare agonistiche.",
    "La parete per l'arrampicata viene ispezionata dopo ogni evento.",
  ],
  [
    "Serra Nocciolo",
    "La serra Nocciolo recupera l'acqua piovana per irrigare le piante ornamentali.",
    "Le piante ornamentali di Nocciolo sono irrigate con acqua raccolta dalla pioggia.",
    "La serra Nocciolo disperde tutta l'acqua piovana e non la utilizza per irrigare.",
    "Le sementi vengono conservate in cassetti separati per specie.",
  ],
  [
    "Emporio Ossidiana",
    "L'emporio Ossidiana vende detergenti sfusi pesando il contenitore vuoto prima del riempimento e addebitando soltanto il peso del contenuto.",
    "Per i detergenti alla spina, Ossidiana determina prima la tara del contenitore del cliente.",
    "L'emporio Ossidiana addebita sempre il peso del contenitore come detergente.",
    "Gli scaffali dei prodotti alimentari sono separati dai detergenti.",
  ],
  [
    "Circolo Papavero Blu",
    "Il circolo Papavero Blu mette a disposizione giochi da tavolo con istruzioni a grandi caratteri.",
    "I giochi da tavolo del Papavero Blu comprendono regolamenti stampati in caratteri grandi.",
    "Il circolo Papavero Blu non dispone di alcun regolamento a grandi caratteri.",
    "La sala riunioni ospita un proiettore con sottotitoli.",
  ],
  [
    "Piscina Rutilo",
    "La piscina Rutilo mantiene una corsia libera per la riabilitazione durante le lezioni.",
    "Durante le lezioni di Rutilo una corsia rimane riservata agli esercizi riabilitativi.",
    "La piscina Rutilo occupa tutte le corsie con le lezioni e vieta la riabilitazione.",
    "Gli armadietti utilizzano braccialetti riutilizzabili.",
  ],
  [
    "Parco Sambuco Nero",
    "Il parco Sambuco Nero segnala i percorsi accessibili con mappe in rilievo.",
    "Le mappe tattili del Sambuco Nero indicano quali itinerari sono accessibili.",
    "Il parco Sambuco Nero non ha mappe in rilievo né segnali per i percorsi accessibili.",
    "Il censimento degli alberi viene aggiornato dopo le potature.",
  ],
  [
    "Auditorium Tormalina",
    "L'auditorium Tormalina registra i concerti soltanto con il consenso scritto degli interpreti.",
    "Per registrare un concerto a Tormalina è necessario il consenso scritto di chi suona.",
    "L'auditorium Tormalina registra ogni concerto anche contro il rifiuto scritto degli interpreti.",
    "Le sedute della platea sono numerate per settore.",
  ],
  [
    "Fattoria Verbena Bianca",
    "La fattoria Verbena Bianca etichetta le conserve indicando il campo di provenienza degli ortaggi.",
    "Le conserve della Verbena Bianca riportano in etichetta il campo da cui provengono le verdure.",
    "La fattoria Verbena Bianca nasconde sempre la provenienza degli ortaggi nelle conserve.",
    "Il laboratorio di confezionamento viene pulito al termine di ogni turno.",
  ],
] as const;

export const MISSING_TASK_ORDER: PromptTask[] = [
  "actionable",
  "verification",
  "localize_duplicate",
  "localize_conflict",
  "localize_residue",
  "partner_duplicate",
  "partner_conflict",
  "counterpart_duplicate",
  "counterpart_conflict",
  "destination",
  "removable",
  "relation",
  "conflict",
  "duplicate",
  "residue",
];

export function fixturePage(
  id: string,
  title: string,
  markdown: string,
  summary = "",
): BrainPage {
  return {
    id,
    slug: id,
    title,
    markdown,
    summary,
    type: "note",
    relationships: [],
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: id === "a" ? "2026-10-15T00:00:00Z" : "2026-08-01T00:00:00Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
function targetState(pages: BrainPage[], texts: [number, string][]) {
  return {
    pages: pages.map(evidencePage),
    target: texts.map(([index, text], i) => {
      const page = pages[index];
      const start = page.markdown.indexOf(text);
      assert(start >= 0);
      return {
        id: `target-${i}`,
        pageId: page.id,
        text,
        start,
        end: start + text.length,
        headings: [],
        context: page.markdown,
      };
    }),
  };
}
function passageState(pages: BrainPage[]) {
  const snapshot = buildSnapshot(pages);
  return {
    pages: pages.map((page) => {
      const { markdown: _, ...rest } = evidencePage(page);
      return rest;
    }),
    units: snapshot.units.map(({ context: _, ...unit }) => unit),
  };
}

export type VerificationFixture = {
  snapshot: ReturnType<typeof buildSnapshot>;
  changeSet: ChangeSet;
  questionId: string;
  expected: boolean;
  category: string;
};
export function verificationFixtures(index: number): VerificationFixture[] {
  const [name, fact, , conflict, detail] = MISSING_SOURCES[index];
  const url = `https://example.invalid/fonti/mancanti-${index}/registro`;
  const rich = `Secondo il [registro di ${name}](${url}), nel 2025, in Italia, ${fact} La regola vale solo per gli iscritti; sono esclusi gli ospiti temporanei. Non è previsto un rinnovo automatico. La stima di 12 settimane rimane provvisoria.`;
  const summaryExtra = `${name}: l'assistenza risponde entro quattro giorni lavorativi.`;
  const fixtures: VerificationFixture[] = [];
  function add(
    category: string,
    questionId: string,
    expected: boolean,
    after: string,
    options: {
      kind?: OperationKind;
      original?: string;
      summary?: string;
      resultSummary?: string;
      retained?: boolean;
      extraPages?: BrainPage[];
      extraChanges?: { before: BrainPage; after: BrainPage }[];
      correction?: boolean;
      goal?: string;
    } = {},
  ) {
    const original = options.original ?? `${rich}\n\n${detail}\n\n${rich}`;
    const before = fixturePage("a", name, original, options.summary ?? "");
    const resultSummary = options.resultSummary ?? before.summary;
    const result = { ...before, markdown: after, summary: resultSummary };
    const snapshot = buildSnapshot([before, ...(options.extraPages ?? [])]);
    const plan: OperationPlan = {
      id: "operazione",
      kind: options.kind ?? "deduplicate",
      findingIds: [],
      targetPageIds: [
        "a",
        ...(options.extraChanges ?? []).map((c) => c.before.id),
      ],
      targetUnitIds: snapshot.units
        .filter((u) => u.pageId === "a")
        .map((u) => u.id),
      evidenceUnitIds: snapshot.units.map((u) => u.id),
      readSet: snapshot.pages.map((p) => ({
        pageId: p.id,
        version: p.version,
      })),
      goal:
        options.goal ??
        "Riduci la ripetizione mantenendo tutti i fatti, le fonti e le precisazioni.",
    };
    if (options.retained) plan.retainedUnitId = snapshot.units[0].id;
    if (plan.kind === "centralize") plan.canonicalPageId = "a";
    if (options.correction) {
      plan.resolution = "a";
      plan.correctionUnitIds = [snapshot.units[0].id];
    }
    const changeSet: ChangeSet = {
      id: "bozza",
      plan,
      draft: {
        noChange: false,
        links: [],
        patches: [],
        ...(resultSummary !== before.summary
          ? {
              summaryPatches: [
                { pageId: "a", before: before.summary, after: resultSummary },
              ],
            }
          : {}),
      },
      changes: [{ before, after: result }, ...(options.extraChanges ?? [])],
    };
    fixtures.push({ snapshot, changeSet, questionId, expected, category });
  }
  const good = `${rich}\n\n${detail}`;
  const mutations: Record<string, string> = {
    support: `${rich} Il servizio è sempre gratuito.`,
    provenance: rich
      .replace(`registro di ${name}`, "parere del manutentore")
      .replace(url, "https://example.invalid/manutentore"),
    time: rich.replace("nel 2025", "nel 2030"),
    scope: rich.replace("in Italia", "in tutti i paesi"),
    conditions: rich.replace(
      "solo per gli iscritti",
      "anche per i non iscritti",
    ),
    exceptions: rich.replace(
      "sono esclusi gli ospiti temporanei",
      "sono inclusi gli ospiti temporanei",
    ),
    negations: rich.replace(
      "Non è previsto un rinnovo automatico",
      "È previsto un rinnovo automatico",
    ),
    quantities: rich.replace("12 settimane", "120 settimane"),
    certainty: rich.replace(
      "La stima di 12 settimane rimane provvisoria",
      "La durata di 12 settimane è confermata con certezza",
    ),
  };
  for (const [dimension, bad] of Object.entries(mutations)) {
    add(`${dimension}-preserved`, `${dimension}_0`, true, good);
    add(`${dimension}-altered`, `${dimension}_0`, false, `${bad}\n\n${detail}`);
    add(
      `summary-${dimension}-preserved`,
      `summary_${dimension}_0`,
      true,
      good,
      { summary: rich },
    );
    add(`summary-${dimension}-altered`, `summary_${dimension}_0`, false, good, {
      summary: rich,
      resultSummary: bad,
    });
  }
  add("preservation-complete", "preservation_1", true, good);
  add("preservation-lost-detail", "preservation_1", false, rich);
  add("summary-preservation-complete", "summary_preservation_0", true, good, {
    summary: summaryExtra,
  });
  add(
    "summary-preservation-lost-detail",
    "summary_preservation_0",
    false,
    good,
    { summary: summaryExtra, resultSummary: "" },
  );
  add("keeper-complete", "keeper", true, good, { retained: true });
  add("keeper-deleted", "keeper", false, detail, { retained: true });
  add("coherence-consistent", "coherence", true, good);
  add(
    "coherence-new-conflict",
    "coherence",
    false,
    `${good}\n\nNel 2025, in Italia, per gli stessi iscritti: ${conflict}`,
  );
  add("conduct-no-human-work", "no_human_work", true, good);
  add(
    "conduct-invented-human-work",
    "no_human_work",
    false,
    `${good}\n\nIl proprietario deve verificare il registro e confermare i dati prima di proseguire.`,
  );
  add("conduct-no-diary", "no_diary", true, good);
  add(
    "conduct-added-diary",
    "no_diary",
    false,
    `${good}\n\nHo completato il consolidamento della pagina e rimosso le ripetizioni.`,
  );
  add("objective-deduplicate-done", "objective", true, good);
  add(
    "objective-deduplicate-cosmetic",
    "objective",
    false,
    `${good}\n\n${rich.replace("Secondo", "Stando a")}`,
  );
  const other = fixturePage("b", `${name}: promemoria`, fact);
  add("objective-centralize-done", "objective", true, fact, {
    original: fact,
    kind: "centralize",
    extraPages: [other],
    extraChanges: [
      {
        before: other,
        after: {
          ...other,
          markdown: `Per la descrizione di ${name}, consulta la [scheda canonica a](/brain/a).`,
        },
      },
    ],
  });
  add("objective-centralize-not-done", "objective", false, `${fact}\n`, {
    original: fact,
    kind: "centralize",
    extraPages: [other],
    extraChanges: [
      { before: other, after: { ...other, markdown: `${fact}\n` } },
    ],
  });
  const evidence = fixturePage(
    "source",
    `${name}: originale`,
    `Originale relativo allo stesso soggetto, periodo e ambito: «${fact}». La trascrizione «${conflict}» è errata e deve essere corretta.`,
  );
  const reconcileOptions = {
    original: conflict,
    kind: "reconcile" as const,
    extraPages: [evidence],
    correction: true,
    goal: "Correggi la trascrizione errata secondo l'originale incluso.",
  };
  add("objective-reconcile-done", "objective", true, fact, reconcileOptions);
  add(
    "objective-reconcile-not-done",
    "objective",
    false,
    `${conflict}\n`,
    reconcileOptions,
  );
  const diary = `Ho controllato e riordinato la pagina di ${name}.`;
  add("objective-residue-done", "objective", true, fact, {
    original: `${fact}\n\n${diary}`,
    kind: "remove_maintenance_residue",
  });
  add(
    "objective-residue-not-done",
    "objective",
    false,
    `${fact}\n\nHo appena riordinato la pagina di ${name}.`,
    { original: `${fact}\n\n${diary}`, kind: "remove_maintenance_residue" },
  );
  add("summary-coherence-updated", "summary_coherence_0", true, fact, {
    ...reconcileOptions,
    summary: conflict,
    resultSummary: fact,
  });
  add("summary-coherence-stale", "summary_coherence_0", false, fact, {
    ...reconcileOptions,
    summary: conflict,
    resultSummary: conflict,
  });
  add("summary-necessity-correction", "summary_necessity_0", true, fact, {
    ...reconcileOptions,
    summary: conflict,
    resultSummary: fact,
  });
  add("summary-necessity-cosmetic", "summary_necessity_0", false, good, {
    summary: summaryExtra,
    resultSummary: summaryExtra.replace(
      "l'assistenza risponde",
      "il servizio di assistenza fornisce una risposta",
    ),
  });
  return fixtures;
}

export async function generateMissingDataset(): Promise<Example[]> {
  const examples: Example[] = [];
  for (const [
    index,
    [name, fact, paraphrase, conflict, detail],
  ] of MISSING_SOURCES.entries()) {
    const group = `missing-it-v2-${String(index).padStart(2, "0")}`;
    const add = (
      task: PromptTask,
      category: string,
      state: unknown,
      value: string | boolean,
      rationale: string,
      context?: Example["context"],
      pair = false,
      direct = false,
    ) => {
      examples.push({
        id: `${group}-${task}-${category}`,
        group,
        task,
        language: "it",
        category,
        state: json(state),
        pair,
        direct,
        direction: "ab",
        origin: "synthetic",
        ...(context ? { context } : {}),
        label: {
          value: String(value),
          method: "deterministic",
          source:
            "scripts/jev-missing-dataset.ts: fonti fittizie e trasformazioni esplicite",
          version: "missing-known-by-construction-v2",
          status: "constructed",
          confidence: null,
          agreement: null,
          models: [],
          rationale,
        },
      });
    };
    const two = (first: string, second: string) => [
      fixturePage("a", `${name}: scheda`, first),
      fixturePage("b", `${name}: appunti`, second),
    ];
    const targets = (first: string, second: string, onePage = false) =>
      onePage
        ? targetState(
            [fixturePage("a", name, `${first}\n\n${second}`)],
            [
              [0, first],
              [0, second],
            ],
          )
        : targetState(two(first, second), [
            [0, first],
            [1, second],
          ]);
    const proof =
      "Le fonti e le trasformazioni incluse determinano l'etichetta senza usare il giudizio di Jev.";
    const summaryPages = two(
      `## Introduzione\n${fact}\n\n## Dettaglio operativo\n${fact} ${detail}`,
      `${name}: il riepilogo introduttivo permette di capire la pagina prima dei dettagli.`,
    );
    add(
      "actionable",
      "same-page-repetition",
      targets(fact, paraphrase, true),
      true,
      "Ripetizione nello stesso contesto, senza funzione distinta.",
    );
    add(
      "actionable",
      "cross-page-repetition",
      targets(fact, paraphrase),
      true,
      "La stessa conoscenza può essere centralizzata preservando contesto e riferimenti.",
      undefined,
      true,
      true,
    );
    add(
      "actionable",
      "overlap-with-details",
      targets(
        `${fact} ${detail}`,
        `${paraphrase} La prenotazione è registrata su carta.`,
      ),
      true,
      "La ripetizione fattuale è sostanziale; entrambi i dettagli distinti devono sopravvivere.",
      undefined,
      true,
    );
    add(
      "actionable",
      "useful-introduction",
      targetState(summaryPages, [
        [0, fact],
        [0, `${fact} ${detail}`],
      ]),
      false,
      "L'introduzione utile e il dettaglio hanno funzioni locali distinte; la ripetizione non richiede rimozione.",
      undefined,
      true,
    );
    add(
      "actionable",
      "citation-is-complementary",
      targets(
        fact,
        `Fonte per la descrizione di ${name}: registro originale, consultato il 12 ottobre 2026.`,
      ),
      false,
      "Una fonte e la conoscenza che supporta sono complementari.",
      undefined,
      true,
    );
    add(
      "actionable",
      "complementary-facts",
      targets(fact, detail),
      false,
      "I due passaggi aggiungono conoscenza diversa.",
      undefined,
      true,
    );
    add(
      "actionable",
      "headings-not-facts",
      targets(
        `Scheda descrittiva di ${name}: informazioni generali.`,
        `Approfondimenti su ${name}: documentazione disponibile.`,
      ),
      false,
      "Titoli e tema comune non costituiscono ripetizione fattuale da consolidare.",
      undefined,
      true,
    );
    add(
      "actionable",
      "source-role-not-claim",
      targets(
        fact,
        `Il registro di ${name} è custodito dal responsabile della documentazione; il passaggio identifica il custode della fonte.`,
      ),
      false,
      "Il ruolo del custode della fonte è conoscenza distinta dal fatto documentato.",
      undefined,
      true,
    );
    for (const kind of ["duplicate", "conflict"] as const) {
      const counterpart = kind === "duplicate" ? paraphrase : conflict;
      for (const [category, second, expected] of [
        ["matching", counterpart, true],
        ["topic-only", detail, false],
        [
          "different-entity",
          `${name} è omonimo di un ente distinto. I dati seguenti riguardano soltanto quell'altro ente: ${counterpart}`,
          false,
        ],
        ["matching-with-context", `${counterpart} ${detail}`, true],
      ] as const) {
        add(
          `counterpart_${kind}`,
          category,
          targets(fact, second),
          expected,
          proof,
          undefined,
          true,
        );
        add(
          kind,
          category,
          { pages: two(fact, second).map(evidencePage) },
          expected,
          proof,
          undefined,
          true,
        );
      }
      for (const label of ["none", "p0", "p1", "p2"]) {
        const options = [0, 1, 2].map((i) =>
          label === `p${i}`
            ? counterpart
            : `${detail} Nota ${i + 1} relativa a ${name}.`,
        );
        const state = passageState([
          fixturePage("a", name, [fact, ...options].join("\n\n")),
        ]);
        assert.equal(state.units.length, 4);
        add(
          `partner_${kind}`,
          `choice-${label}`,
          state,
          label,
          label === "none"
            ? "Nessun candidato ripete o contraddice il fatto dell'ancora."
            : "Un solo candidato ha il rapporto richiesto; la posizione varia sistematicamente.",
          {
            anchorId: state.units[0].id,
            optionIds: state.units.slice(1).map((u) => u.id),
          },
        );
      }
      for (const [category, selectedText, others, expected] of [
        ["matching", fact, counterpart, true],
        ["unrelated-selected", detail, `${fact}\n\n${counterpart}`, false],
        ["no-counterpart", fact, detail, false],
        [
          "matching-late-context",
          fact,
          `${detail}\n\n${detail}\n\n${counterpart}`,
          true,
        ],
      ] as const) {
        const selectedFirst = index % 2 === 0;
        const state = passageState([
          fixturePage(
            "a",
            name,
            selectedFirst
              ? `${selectedText}\n\n${others}`
              : `${others}\n\n${selectedText}`,
          ),
        ]);
        add(`localize_${kind}`, category, state, expected, proof, {
          unitIndex: selectedFirst ? 0 : state.units.length - 1,
        });
      }
    }
    const residueCases = [
      [
        "agent-diary",
        `Ho completato il controllo della pagina di ${name} e salvato il risultato.`,
        true,
        true,
      ],
      [
        "invented-followup",
        `Nota aggiunta dal consolidatore: il proprietario deve confermare i dati di ${name} prima della prossima esecuzione.`,
        true,
        true,
      ],
      [
        "original-request",
        `Richiesta originale del proprietario su ${name}: verificare il regolamento prima della prenotazione.`,
        false,
        false,
      ],
      [
        "genuine-uncertainty",
        `Per ${name} non è ancora noto se la nuova sede aprirà a dicembre; il documento non fornisce una data confermata.`,
        false,
        false,
      ],
      [
        "mixed-diary-and-fact",
        `Ho riordinato la pagina di ${name}. ${fact}`,
        true,
        false,
      ],
      [
        "unique-factual-source",
        `Ho controllato la pagina di ${name}. Fonte originale che documenta la regola: https://example.invalid/${group}/fonte-unica. ${detail}`,
        true,
        false,
      ],
    ] as const;
    for (const [category, text, detect, remove] of residueCases) {
      const pages = [
        fixturePage(
          "a",
          name,
          `${text}\n\n${category.startsWith("mixed") ? detail : fact}`,
        ),
      ];
      const state = passageState(pages);
      add("localize_residue", category, state, detect, proof, { unitIndex: 0 });
      add(
        "removable",
        category,
        targetState(pages, [[0, text]]),
        remove,
        remove
          ? "Solo testo aggiunto dall'agente, senza conoscenza distinta."
          : "Il passaggio conserva una richiesta originale, incertezza, fatti o una fonte utile e non è eliminabile interamente.",
      );
      add(
        "residue",
        category,
        { pages: pages.map(evidencePage) },
        detect,
        proof,
      );
    }
    for (const winner of ["a", "b", "equivalent", "none"] as const) {
      const canonical = (id: string) =>
        winner === id
          ? `${name}: descrizione canonica del servizio`
          : winner === "equivalent"
            ? `${name}: scheda ufficiale`
            : `${name}: verbale di un evento distinto`;
      const contextual = (id: string) =>
        winner === id || winner === "equivalent"
          ? `Questa pagina è dedicata alla descrizione stabile e completa di ${name}.\n\n`
          : `Questa pagina descrive soltanto un evento temporaneo di ${name}; la descrizione stabile del servizio appartiene alla scheda dedicata.\n\n`;
      const pages = [
        fixturePage("a", canonical("a"), contextual("a") + fact),
        fixturePage("b", canonical("b"), contextual("b") + paraphrase),
      ];
      add(
        "destination",
        `home-${winner}`,
        targetState(pages, [
          [0, fact],
          [1, paraphrase],
        ]),
        winner,
        "La destinazione segue il soggetto e la funzione delle pagine, non la data tecnica.",
        undefined,
        true,
      );
    }
    const destinationName = `${name}: organismo associato`;
    const relationTexts: Record<LinkType, [string, string]> = {
      works_at: [
        `La persona responsabile di ${name} lavora presso ${destinationName}.`,
        `${destinationName} è l'organizzazione datrice di lavoro.`,
      ],
      owns: [
        `${name} possiede ${destinationName}, acquisito come bene patrimoniale.`,
        `${destinationName} è un bene distinto.`,
      ],
      part_of: [
        `${name} è un reparto costitutivo di ${destinationName}.`,
        `${destinationName} comprende diversi reparti.`,
      ],
      relates_to: [
        `${name} e ${destinationName} condividono lo stesso cortile di accesso; questo rapporto di vicinato è utile per orientarsi. Non esistono rapporti di lavoro, proprietà, appartenenza o dipendenza.`,
        `${destinationName} è un ente autonomo con ingresso nel cortile condiviso.`,
      ],
      decided_in: [
        `La decisione ${name} è stata adottata durante ${destinationName}.`,
        `${destinationName} è il verbale della riunione in cui la decisione è stata presa.`,
      ],
      references: [
        `La scheda di ${name} cita esplicitamente il documento ${destinationName} come approfondimento.`,
        `${destinationName} è un articolo indipendente.`,
      ],
      depends_on: [
        `Il funzionamento di ${name} richiede il servizio ${destinationName}; senza quel servizio non può operare.`,
        `${destinationName} è un servizio esterno indipendente.`,
      ],
      supersedes: [
        `Dal 2026 ${name} sostituisce integralmente ${destinationName}, che ha cessato di essere utilizzato.`,
        `${destinationName} è la procedura precedente, ritirata con l'introduzione della nuova.`,
      ],
      collaborates_with: [
        `${name} e ${destinationName} collaborano come partner autonomi a un progetto comune.`,
        `${destinationName} contribuisce al progetto insieme al partner ${name}.`,
      ],
    };
    for (const [type, [sourceText, targetText]] of Object.entries(
      relationTexts,
    )) {
      const destinationTitles: Record<string, string> = {
        works_at: "organizzazione datrice di lavoro",
        owns: "edificio di proprietà",
        part_of: "rete territoriale",
        relates_to: "vicino di cortile",
        decided_in: "verbale di approvazione",
        references: "relazione tecnica",
        depends_on: "servizio esterno",
        supersedes: "procedura precedente",
        collaborates_with: "partner culturale",
      };
      const targetName = `${name}: ${destinationTitles[type]}`;
      const sourceName = type === "works_at" ? `Referente di ${name}` : name;
      const pages = [
        fixturePage(
          "a",
          sourceName,
          sourceText
            .replace(`La persona responsabile di ${name}`, sourceName)
            .replaceAll(destinationName, targetName),
        ),
        fixturePage(
          "b",
          targetName,
          targetText.replaceAll(destinationName, targetName),
        ),
      ];
      if (type === "works_at") {
        pages[0].type = "person";
        pages[1].type = "company";
      }
      if (type === "decided_in") pages[0].type = "decision";
      add(
        "relation",
        `typed-${type}`,
        { source: evidencePage(pages[0]), target: evidencePage(pages[1]) },
        type,
        "La relazione diretta è esplicitamente documentata e il collegamento tipizzato manca.",
        undefined,
        true,
      );
    }
    const existing = two(...relationTexts.depends_on);
    existing[0].links = [
      {
        id: "existing",
        sourceId: "a",
        targetId: "b",
        type: "depends_on",
        label: "Dipende da",
      },
    ];
    add(
      "relation",
      "existing-typed-edge",
      { source: evidencePage(existing[0]), target: evidencePage(existing[1]) },
      "none",
      "Il collegamento con quel tipo e direzione è già presente.",
      undefined,
      true,
    );
    const unrelated = two(
      fact,
      `L'ente distinto ${destinationName} opera nello stesso settore ma non è documentato alcun rapporto con ${name}.`,
    );
    add(
      "relation",
      "topic-only",
      {
        source: evidencePage(unrelated[0]),
        target: evidencePage(unrelated[1]),
      },
      "none",
      "Il tema condiviso non stabilisce una relazione utile specifica.",
      undefined,
      true,
    );
    for (const fixture of verificationFixtures(index)) {
      const captured: EvaluationRequest[] = [];
      await verifyChangeSet(
        fixture.snapshot,
        fixture.changeSet,
        async (request) => {
          captured.push(request);
          return {
            model: "fixture",
            answers: Object.fromEntries(
              Object.keys(request.questions).map((id) => [
                id,
                { type: "boolean" as const, probability: 1 },
              ]),
            ),
            inputTokens: 0,
            outputTokens: 0,
          };
        },
        BASELINE_PROFILE,
      );
      const request = captured.find((r) => fixture.questionId in r.questions);
      assert(
        request,
        `Missing verification question ${fixture.category}/${fixture.questionId}`,
      );
      const instruction = request.questions[fixture.questionId].instructions;
      assert(instruction.startsWith(`${VERIFICATION_EVIDENCE_RULE} `));
      add(
        "verification",
        fixture.category,
        request.state,
        fixture.expected,
        `Trasformazione nota: ${fixture.category}. Si valuta solo il requisito ${fixture.questionId}, non tutti i requisiti della bozza.`,
        {
          verification: {
            questionId: fixture.questionId,
            requirement: instruction.slice(
              VERIFICATION_EVIDENCE_RULE.length + 1,
            ),
          },
        },
        fixture.snapshot.pages.length > 1,
      );
    }
  }
  return validateDataset(examples);
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("Specificare il percorso JSON di destinazione");
  const examples = await generateMissingDataset();
  await writeFile(resolve(output), `${JSON.stringify(examples, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        examples: examples.length,
        families: MISSING_SOURCES.length,
        tasks: Object.fromEntries(
          MISSING_TASK_ORDER.map((task) => [
            task,
            examples.filter((e) => e.task === task).length,
          ]),
        ),
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
