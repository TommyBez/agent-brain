import type { BrainPage, LinkType } from "../../lib/brain/types";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../../lib/maintenance/consolidator/snapshot";
import type { OperationKind } from "../../lib/maintenance/consolidator/types";
import type { AnalysisCalibrationCase } from "./consolidation-analysis-calibration-fixtures";

export const ANALYSIS_HOLDOUT_V2_VERSION = "analysis-holdout-2026-09-25-v2";

type ExpectedLink = { sourceId: string; targetId: string; type: LinkType };
type Definition = {
  id: string;
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
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
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
 * A fresh, pre-inference holdout after the first holdout was exposed. All names,
 * documents and source quotations are invented here. No model output defines
 * these expectations. Technical timestamps are fixtures, never factual evidence.
 * Four positive operations and four negatives have fully enumerated link oracles.
 */
export function analysisHoldoutV2Cases(): AnalysisCalibrationCase[] {
  const duplicated =
    "Il manuale originale della sacca fittizia Vela-29 riporta: «La tasca interna misura 14 × 9 cm e si chiude con una cerniera; non è impermeabile».";
  const definitions: Definition[] = [
    {
      id: "analysis-v2-hold-satchel-duplicate",
      description:
        "Duplicato esatto senza data fattuale: dimensioni, negazione e fonte devono sopravvivere una volta sola.",
      pages: [
        page(
          "av2-01",
          "Sacca fittizia Vela-29",
          `${duplicated}\n\n${duplicated}`,
        ),
      ],
      required: ["deduplicate"],
    },
    {
      id: "analysis-v2-hold-exhibition-centralize",
      description:
        "Due estratti dello stesso piano di mostra condividono il conteggio e conservano dettagli complementari.",
      pages: [
        page(
          "av2-02-project",
          "Mostra fittizia Atlante delle Ombre",
          "La mostra fittizia Atlante delle Ombre è un progetto espositivo. Estratto originale del piano AO-31: «La mostra presenta sei installazioni. La sala di destinazione è la galleria est».",
          "project",
        ),
        page(
          "av2-02-note",
          "Nota sulla mostra fittizia Atlante delle Ombre",
          "Questa nota riguarda la mostra fittizia Atlante delle Ombre. Estratto originale del piano AO-31: «La mostra presenta sei installazioni. Le due maquette didattiche sono escluse dal conteggio e la referente è Ester Lodi».",
        ),
      ],
      required: ["centralize"],
      allowed: ["centralize", "add_link"],
      allowedLinks: navigation("av2-02-note", "av2-02-project"),
    },
    {
      id: "analysis-v2-hold-transmitter-ownership",
      description:
        "L'atto riprodotto fonda una proprietà diretta fra associazione e trasmettitore identificati esattamente.",
      pages: [
        page(
          "av2-03-association",
          "Associazione fittizia Riva-73",
          "L'associazione fittizia Riva-73, identificativo RV-73, organizza esperimenti radio. L'atto originale RV-73/11 riporta: «Il trasmettitore fittizio Quinto, matricola QT-208, è di proprietà dell'associazione Riva-73 RV-73».",
          "client",
        ),
        page(
          "av2-03-transmitter",
          "Trasmettitore fittizio Quinto QT-208",
          "Il trasmettitore fittizio Quinto, matricola QT-208, utilizza un involucro in alluminio. Testo originale della scheda QT-208: «Alimentazione nominale: 12 V».",
        ),
      ],
      required: ["add_link"],
      requiredLinks: [link("av2-03-association", "av2-03-transmitter", "owns")],
      allowedLinks: [
        link("av2-03-association", "av2-03-transmitter", "owns"),
        ...navigation("av2-03-association", "av2-03-transmitter"),
      ],
    },
    {
      id: "analysis-v2-hold-original-manual-correction",
      description:
        "Il testo originale riprodotto smentisce direttamente la trascrizione della stessa versione del prodotto.",
      pages: [
        page(
          "av2-04",
          "Contenitore fittizio Esagono-17",
          "Scheda derivata dal manuale E-17 per il contenitore fittizio Esagono-17, variante standard: il contenitore possiede sei scomparti separati.\n\nTesto originale completo della voce del manuale E-17 per Esagono-17, variante standard: «Il contenitore possiede nove scomparti separati. Le pareti divisorie sono fisse». La scheda derivata e questa voce originale descrivono la stessa variante standard.",
        ),
      ],
      required: ["reconcile"],
    },
    {
      id: "analysis-v2-hold-packaging-distinct-conditions",
      description:
        "Due prescrizioni sulla stessa scatola hanno condizioni e contenuti distinti: nessuna eliminazione o riconciliazione.",
      pages: [
        page(
          "av2-05",
          "Scatola fittizia Cobalto-30",
          "Il manuale originale C-30 richiede un inserto di cartone nella scatola fittizia Cobalto-30 quando contiene bicchieri; l'inserto separa i bordi.\n\nIl manuale originale C-30 richiede un sacchetto di feltro nella scatola fittizia Cobalto-30 quando contiene posate; il sacchetto protegge le superfici lucidate.",
        ),
      ],
    },
    {
      id: "analysis-v2-hold-authentic-original-uncertainty",
      description:
        "L'ipotesi originaria resta conoscenza, senza trasformarsi in residuo di manutenzione o in un incarico.",
      pages: [
        page(
          "av2-06",
          "Motivo della melodia fittizia Fioritura-9",
          "Testo originale della nota musicologica F-9: «Il motivo iniziale della melodia fittizia Fioritura-9 potrebbe derivare da un canto di lavoro, ma l'attribuzione è solo un'ipotesi e la testimonianza disponibile non la conferma». Questa è l'unica informazione disponibile sull'origine del motivo.",
        ),
      ],
    },
    {
      id: "analysis-v2-hold-researcher-homonym",
      description:
        "L'autrice citata nel catalogo è omonima ma ha un identificativo diverso dalla persona candidata.",
      pages: [
        page(
          "av2-07-catalogue",
          "Catalogo fittizio Nodi-52",
          "Il frontespizio originale del catalogo fittizio Nodi-52 riporta: «Autrice: Carla Vanni, identificativo CV-81, illustratrice residente a Siena». Il catalogo descrive nodi ornamentali.",
          "article",
        ),
        page(
          "av2-07-person",
          "Carla Vanni, persona fittizia CV-18",
          "Carla Vanni, identificativo fittizio CV-18, è una ricercatrice residente a Trieste specializzata in acustica subacquea. Fonte originale: anagrafica CV-18.",
          "person",
        ),
      ],
    },
    {
      id: "analysis-v2-hold-edit-time-is-not-correction",
      description:
        "La revisione tecnica più recente di una pagina non risolve il dissenso di due inventari della stessa data.",
      pages: [
        {
          ...page(
            "av2-08",
            "Dotazione del teatro fittizio Cadenza-64",
            "Estratto originale dell'inventario indipendente CD-A: «Al 3 febbraio 2026 il teatro fittizio Cadenza-64 possiede 28 leggii».\n\nEstratto originale dell'inventario indipendente CD-B: «Al 3 febbraio 2026 il medesimo teatro fittizio Cadenza-64 possiede 31 leggii». L'estratto CD-B è stato copiato in questa pagina nell'ultima revisione tecnica. Nessuno dei due inventari rettifica l'altro; non esiste una prova che stabilisca quale conteggio sia corretto.",
          ),
          updatedAt: "2026-09-25T20:00:00.000Z",
        },
      ],
    },
  ];
  return definitions.map((definition) => {
    const snapshot = buildSnapshot(
      definition.pages,
      "2026-09-25T00:00:00.000Z",
    );
    // Corpus identity is independent of runtime policy/version changes.
    snapshot.id = `${ANALYSIS_HOLDOUT_V2_VERSION}:snapshot:${definition.id}`;
    const kind = definition.pages.length === 1 ? "document" : "pair";
    const tasks = createAnalysisTasks(snapshot).filter(
      (task) => task.kind === kind,
    );
    if (tasks.length !== 1)
      throw new Error(`Expected one complete task for ${definition.id}`);
    const required = definition.required ?? [];
    return {
      id: definition.id,
      split: "holdout",
      description: definition.description,
      snapshot,
      task: {
        ...tasks[0],
        id: `${ANALYSIS_HOLDOUT_V2_VERSION}:task:${definition.id}`,
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
