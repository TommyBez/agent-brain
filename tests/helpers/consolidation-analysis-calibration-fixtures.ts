import type { BrainPage, LinkType } from "../../lib/brain/types";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../../lib/maintenance/consolidator/snapshot";
import type {
  AnalysisTask,
  OperationKind,
  Snapshot,
} from "../../lib/maintenance/consolidator/types";

export const ANALYSIS_CALIBRATION_VERSION = "analysis-calibration-2026-09-25-1";

type ExpectedLink = { sourceId: string; targetId: string; type: LinkType };

export type AnalysisCalibrationCase = {
  id: string;
  split: "calibration" | "holdout";
  description: string;
  snapshot: Snapshot;
  task: AnalysisTask;
  expected: {
    required: OperationKind[];
    allowed: OperationKind[];
    requiredLinks: ExpectedLink[];
    allowedLinks: ExpectedLink[];
  };
};

type Definition = {
  id: string;
  split: AnalysisCalibrationCase["split"];
  description: string;
  pages: BrainPage[];
  required?: OperationKind[];
  allowed?: OperationKind[];
  requiredLinks?: ExpectedLink[];
  allowedLinks?: ExpectedLink[];
};

function page(
  id: string,
  title: string,
  markdown: string,
  type: BrainPage["type"] = "note",
): BrainPage {
  return {
    id,
    slug: id,
    title,
    type,
    markdown,
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

function link(
  sourceId: string,
  targetId: string,
  type: LinkType,
): ExpectedLink {
  return { sourceId, targetId, type };
}

function navigation(sourceId: string, targetId: string): ExpectedLink[] {
  return [
    link(sourceId, targetId, "references"),
    link(sourceId, targetId, "relates_to"),
    link(targetId, sourceId, "relates_to"),
  ];
}

/**
 * Frozen before provider evaluation. These wholly invented corpora are distinct
 * from development fixtures and from the verifier calibration/holdout corpus.
 * Each case scores one complete document or unordered page-pair task. A matching
 * operation kind alone never licenses an arbitrary extra directed typed link.
 */
export function analysisCalibrationCases(): AnalysisCalibrationCase[] {
  const exact =
    "L'archivio fittizio Nembus riceve visite il martedì dalle 14:00 alle 17:00, solo su prenotazione. Fonte: regolamento N-16 del 4 maggio 2026.";
  const negation =
    "Il sensore fittizio Corindone C-8 non deve superare 24 V; la tolleranza ammessa è ±0,5 V solo durante la prova a banco. Fonte: scheda C-8 revisione 2.";
  const definitions: Definition[] = [
    {
      id: "analysis-cal-exact-duplicate",
      split: "calibration",
      description: "Duplicato esatto con orario, condizione e fonte.",
      pages: [
        page("ac01", "Visite all'archivio Nembus", `${exact}\n\n${exact}`),
      ],
      required: ["deduplicate"],
    },
    {
      id: "analysis-cal-paraphrase-duplicate",
      split: "calibration",
      description:
        "Due formulazioni conservano la stessa data, misura, eccezione e fonte.",
      pages: [
        page(
          "ac02",
          "Contenitore fittizio Belite",
          "Il contenitore fittizio Belite ha capacità utile di 18 litri dal 6 giugno 2026, escluso l'inserto. Fonte: specifica B-14.\n\nDal 6 giugno 2026 la capacità utile del contenitore fittizio Belite, senza l'inserto, è pari a 18 litri. Fonte: specifica B-14.",
        ),
      ],
      required: ["deduplicate"],
    },
    {
      id: "analysis-cal-complementary-centralization",
      split: "calibration",
      description:
        "Una scheda progetto e una nota conservano dettagli complementari dello stesso piano.",
      pages: [
        page(
          "ac03-project",
          "Progetto fittizio Lanterna-42",
          "Il progetto fittizio Lanterna-42 realizza una serra didattica. Il piano L-42 approva un budget di 7.200 euro e indica Nora Valli come responsabile.",
          "project",
        ),
        page(
          "ac03-note",
          "Nota sul progetto fittizio Lanterna-42",
          "Questa nota riguarda il progetto fittizio Lanterna-42. Il piano L-42 approva un budget di 7.200 euro e fissa la consegna al 12 dicembre 2026.",
        ),
      ],
      required: ["centralize"],
      allowed: ["centralize", "add_link"],
      allowedLinks: navigation("ac03-note", "ac03-project"),
    },
    {
      id: "analysis-cal-employment-link",
      split: "calibration",
      description:
        "La fonte identifica esattamente persona, datore e direzione works_at.",
      pages: [
        page(
          "ac04-person",
          "Irene Neri, persona fittizia IN-17",
          "Irene Neri, identificativo fittizio IN-17, lavora come archivista presso la cooperativa fittizia Bosco Blu, identificativo BB-9, dal 2 aprile 2026. Fonte: comunicato BB-9/6.",
          "person",
        ),
        page(
          "ac04-org",
          "Bosco Blu, cooperativa fittizia BB-9",
          "La cooperativa fittizia Bosco Blu, identificativo BB-9, gestisce archivi cartacei a Ferrara.",
          "client",
        ),
      ],
      required: ["add_link"],
      requiredLinks: [link("ac04-person", "ac04-org", "works_at")],
      allowedLinks: [
        link("ac04-person", "ac04-org", "works_at"),
        ...navigation("ac04-person", "ac04-org"),
      ],
    },
    {
      id: "analysis-cal-explicit-correction",
      split: "calibration",
      description:
        "Una rettifica riprodotta autorizza la correzione della cifra trascritta.",
      pages: [
        page(
          "ac05",
          "Posti del corso fittizio Isola-7",
          "Il corso fittizio Isola-7 ha 12 posti disponibili per l'edizione di ottobre 2026. Fonte dichiarata: prospetto I-7.\n\nTesto originale della rettifica I-7 del 10 settembre 2026: «Per l'edizione di ottobre 2026 del corso Isola-7 i posti disponibili sono 21. La cifra 12 della scheda è un errore di trascrizione; il valore corretto è 21».",
        ),
      ],
      required: ["reconcile"],
    },
    {
      id: "analysis-cal-pure-maintenance-residue",
      split: "calibration",
      description:
        "Un paragrafo aggiunto dal consolidatore contiene solo il suo diario operativo.",
      pages: [
        page(
          "ac06",
          "Finitura del prototipo fittizio Pomice",
          "La finitura del prototipo fittizio Pomice è opaca. Fonte: campione approvato P-11.\n\nRapporto del consolidatore notturno: ho analizzato questa pagina, verificato i duplicati e concluso la manutenzione automatica alle 03:00.",
        ),
      ],
      required: ["remove_maintenance_residue"],
    },
    {
      id: "analysis-cal-single-fact-noop",
      split: "calibration",
      description: "Una singola informazione pulita non richiede interventi.",
      pages: [
        page(
          "ac07",
          "Etichetta fittizia Diaspro",
          "L'etichetta fittizia Diaspro usa carta avorio da 120 g/m². Fonte: distinta D-6.",
        ),
      ],
    },
    {
      id: "analysis-cal-original-uncertainty",
      split: "calibration",
      description:
        "L'incertezza originaria è conoscenza del soggetto, non un incarico umano.",
      pages: [
        page(
          "ac08",
          "Origine del reperto fittizio Ulmite",
          "Secondo il catalogo U-3, il reperto fittizio Ulmite potrebbe provenire dal laboratorio orientale; l'attribuzione è incerta e non è stata confermata. Questa incertezza appartiene al catalogo originale.",
        ),
      ],
    },
    {
      id: "analysis-cal-homonyms",
      split: "calibration",
      description:
        "Due persone omonime con identificativi e residenze diversi non sono la stessa entità.",
      pages: [
        page(
          "ac09-a",
          "Lea Moro, persona fittizia LM-1",
          "La persona fittizia Lea Moro con identificativo LM-1 risiede a Ravenna e restaura ceramiche.",
          "person",
        ),
        page(
          "ac09-b",
          "Lea Moro, persona fittizia LM-2",
          "La persona fittizia Lea Moro con identificativo LM-2 risiede a Trento e costruisce aquiloni. È una persona distinta da ogni altra omonima.",
          "person",
        ),
      ],
    },
    {
      id: "analysis-cal-unresolved-independent-sources",
      split: "calibration",
      description:
        "Fonti indipendenti discordano sulla stessa data, senza rettifica o prevalenza.",
      pages: [
        page(
          "ac10",
          "Chiusura del magazzino fittizio Selce",
          "La relazione indipendente A afferma che il magazzino fittizio Selce è stato chiuso il 9 agosto 2026.\n\nLa relazione indipendente B afferma che lo stesso magazzino fittizio Selce è stato chiuso il 12 agosto 2026. Nessuna delle due relazioni rettifica l'altra e non è disponibile una prova che stabilisca quale data sia corretta.",
        ),
      ],
    },
    {
      id: "analysis-cal-source-associations-distinct",
      split: "calibration",
      description:
        "Due osservazioni identiche nel valore hanno fonti diverse da preservare.",
      pages: [
        page(
          "ac11",
          "Peso del campione fittizio Titanite",
          "La bilancia del laboratorio A ha rilevato 86 grammi per il campione fittizio Titanite il 7 luglio 2026; fonte: rapporto A-86.\n\nLa bilancia del laboratorio B ha rilevato 86 grammi per il campione fittizio Titanite il 7 luglio 2026; fonte: rapporto B-86.",
        ),
      ],
    },
    {
      id: "analysis-cal-topic-only",
      split: "calibration",
      description:
        "Condividere il tema del vetro non fonda un collegamento tra imprese distinte.",
      pages: [
        page(
          "ac12-a",
          "Impresa fittizia Vetrina-12",
          "L'impresa fittizia Vetrina-12 produce recipienti in vetro a Mantova.",
          "client",
        ),
        page(
          "ac12-b",
          "Impresa fittizia Trasparia-38",
          "L'impresa fittizia Trasparia-38 produce lastre in vetro a Cuneo.",
          "client",
        ),
      ],
    },
    {
      id: "analysis-hold-duplicate-negation-precision",
      split: "holdout",
      description: "Duplicato con negazione, tolleranza e condizione di prova.",
      pages: [
        page(
          "ah01",
          "Limiti del sensore fittizio Corindone",
          `${negation}\n\n${negation}`,
        ),
      ],
      required: ["deduplicate"],
    },
    {
      id: "analysis-hold-centralize-exception",
      split: "holdout",
      description:
        "La centralizzazione deve conservare l'eccezione e la destinazione indicate dal medesimo piano.",
      pages: [
        page(
          "ah02-project",
          "Progetto fittizio Tessera-8",
          "Il progetto fittizio Tessera-8 allestisce dodici pannelli modulari per la sala ovest. Il piano T-8 esclude i due pannelli dimostrativi dal conteggio.",
          "project",
        ),
        page(
          "ah02-note",
          "Nota sul progetto fittizio Tessera-8",
          "Questa nota riguarda il progetto fittizio Tessera-8. Il piano T-8 prevede dodici pannelli modulari e una consegna il 18 novembre 2026.",
        ),
      ],
      required: ["centralize"],
      allowed: ["centralize", "add_link"],
      allowedLinks: navigation("ah02-note", "ah02-project"),
    },
    {
      id: "analysis-hold-dependency-link",
      split: "holdout",
      description:
        "Una dipendenza esplicita ha direzione dal processo alla risorsa.",
      pages: [
        page(
          "ah03-process",
          "Processo fittizio Alveo-5",
          "Il processo fittizio Alveo-5 richiede il servizio fittizio Rugiada-2, identificativo RG-2, per ottenere i codici dei lotti; senza RG-2 non può avviare l'elaborazione. Fonte: specifica A-5.",
          "project",
        ),
        page(
          "ah03-service",
          "Servizio fittizio Rugiada-2 RG-2",
          "Il servizio fittizio Rugiada-2, identificativo RG-2, pubblica codici di lotto tramite un'interfaccia interna.",
          "project",
        ),
      ],
      required: ["add_link"],
      requiredLinks: [link("ah03-process", "ah03-service", "depends_on")],
      allowedLinks: [
        link("ah03-process", "ah03-service", "depends_on"),
        ...navigation("ah03-process", "ah03-service"),
      ],
    },
    {
      id: "analysis-hold-documented-succession",
      split: "holdout",
      description:
        "Una nota di stato e un avviso documentano il cambio con date effettive.",
      pages: [
        page(
          "ah04",
          "Responsabile del presidio fittizio Agata-6",
          "Stato attuale del presidio fittizio Agata-6 al 15 settembre 2026: la responsabile è Marta Elmi. Fonte dichiarata: registro A-6.\n\nAvviso originale A-6 del 25 febbraio 2026: «Marta Elmi ha diretto Agata-6 fino al 28 febbraio 2026 incluso. Dal 1 marzo 2026 la responsabile è Daria Santi, che sostituisce Marta Elmi nell'incarico».",
        ),
      ],
      required: ["reconcile"],
    },
    {
      id: "analysis-hold-already-distinct-scopes",
      split: "holdout",
      description:
        "Valori distinti con ambiti già espliciti non rappresentano duplicazione o conflitto.",
      pages: [
        page(
          "ah05",
          "Spazi del centro fittizio Basalto",
          "Nel centro fittizio Basalto, la sala nord accoglie 16 tavoli. Fonte: inventario B-2.\n\nNel centro fittizio Basalto, la sala sud accoglie 9 armadietti. Fonte: inventario B-2.",
        ),
      ],
    },
    {
      id: "analysis-hold-newer-metadata-no-authority",
      split: "holdout",
      description:
        "Una fonte non riprodotta e un aggiornamento tecnico recente non autorizzano una correzione.",
      pages: [
        page(
          "ah06",
          "Numero di campioni fittizi Galena",
          "La relazione indipendente G-A afferma che la collezione fittizia Galena comprendeva 32 campioni al 15 maggio 2026.\n\nLa relazione indipendente G-B afferma che la medesima collezione comprendeva 35 campioni al 15 maggio 2026. La scheda che riporta G-B è stata aggiornata tecnicamente più tardi. I testi originali delle due relazioni non sono presenti e non esiste una rettifica documentata.",
        ),
      ],
    },
    {
      id: "analysis-hold-mixed-maintenance-and-fact",
      split: "holdout",
      description:
        "Un passaggio misto non è eliminabile interamente come residuo senza perdere un fatto unico.",
      pages: [
        page(
          "ah07",
          "Colore del modulo fittizio Tormalina",
          "Rapporto di manutenzione del consolidatore: ho verificato questa pagina. La scheda tecnica fittizia T-19 specifica che il modulo Tormalina usa guarnizioni verdi resistenti a 80 °C.",
        ),
      ],
    },
    {
      id: "analysis-hold-organization-homonym",
      split: "holdout",
      description:
        "Il datore citato ha lo stesso nome, ma non l'identificativo dell'organizzazione candidata.",
      pages: [
        page(
          "ah08-person",
          "Paolo Venturi, persona fittizia PV-6",
          "La persona fittizia Paolo Venturi PV-6 lavora presso Orma, azienda fittizia OR-11 con sede a Lucca. Fonte: anagrafica PV-6.",
          "person",
        ),
        page(
          "ah08-org",
          "Orma, azienda fittizia OR-27",
          "Orma OR-27 è un'azienda fittizia con sede a Como. È distinta dall'omonima Orma OR-11 di Lucca; le due aziende non hanno rapporti documentati.",
          "client",
        ),
      ],
      // The disambiguation explicitly mentions the employer, not Paolo himself;
      // it supplies no relationship to the candidate person page.
    },
  ];
  return definitions.map((definition) => {
    const snapshot = buildSnapshot(
      definition.pages,
      "2026-09-25T00:00:00.000Z",
    );
    const kind = definition.pages.length === 1 ? "document" : "pair";
    const tasks = createAnalysisTasks(snapshot).filter(
      (task) => task.kind === kind,
    );
    if (tasks.length !== 1)
      throw new Error(
        `Fixture must have one complete focus task: ${definition.id}`,
      );
    const required = definition.required ?? [];
    return {
      id: definition.id,
      split: definition.split,
      description: definition.description,
      snapshot,
      // A calibration corpus is fixed independently from runtime decision gates.
      task: {
        ...tasks[0],
        id: `${ANALYSIS_CALIBRATION_VERSION}:${definition.id}`,
      },
      expected: {
        required,
        allowed: definition.allowed ?? required,
        requiredLinks: definition.requiredLinks ?? [],
        allowedLinks: definition.allowedLinks ?? [],
      },
    };
  });
}
