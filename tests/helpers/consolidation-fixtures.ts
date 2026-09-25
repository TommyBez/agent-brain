import type { BrainPage, LinkType } from "../../lib/brain/types";
import type {
  OperationKind,
  OperationPlan,
  Snapshot,
} from "../../lib/maintenance/consolidator/types";

export type ConsolidationFixture = {
  id: string;
  description: string;
  pages: BrainPage[];
  focusPageIds: string[];
  expected: {
    kind?: OperationKind;
    linkType?: LinkType;
    unresolved?: boolean;
    preserve?: string[];
  };
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
    updatedAt: "2026-09-25T00:00:00.000Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

/** Invented, public-safe material only. No fixture is derived from the owner's Brain. */
export function consolidationFixtures(): ConsolidationFixture[] {
  const duplicate =
    "Dal 3 febbraio 2026 il laboratorio fittizio Aurora apre alle 09:00 nei giorni feriali, esclusi i festivi. Fonte: regolamento Aurora R-7 del 20 gennaio 2026.";
  return [
    {
      id: "duplicate",
      description:
        "Duplicato esatto con data, eccezione e fonte da preservare.",
      pages: [
        page(
          "fixture-duplicate",
          "Orari del laboratorio fittizio Aurora",
          `${duplicate}\n\n${duplicate}`,
        ),
      ],
      focusPageIds: ["fixture-duplicate"],
      expected: {
        kind: "deduplicate",
        preserve: ["3 febbraio 2026", "09:00", "esclusi i festivi", "R-7"],
      },
    },
    {
      id: "complementary",
      description:
        "Sovrapposizione tra pagine con dettagli complementari da riunire senza perdita.",
      pages: [
        page(
          "fixture-complementary-a",
          "Progetto fittizio Faro",
          "Il progetto fittizio Faro ha un budget approvato di 4.500 euro. La consegna è prevista il 30 novembre 2026. Fonte: piano Faro P-2 del 5 settembre 2026.",
          "project",
        ),
        page(
          "fixture-complementary-b",
          "Promemoria sul progetto fittizio Faro",
          "Il progetto fittizio Faro ha un budget approvato di 4.500 euro. La responsabile è Ada Sereni. Fonte: piano Faro P-2 del 5 settembre 2026.",
        ),
      ],
      focusPageIds: ["fixture-complementary-a", "fixture-complementary-b"],
      expected: {
        kind: "centralize",
        preserve: ["4.500", "30 novembre 2026", "Ada Sereni", "P-2"],
      },
    },
    {
      id: "typed-link",
      description:
        "Relazione works_at dalla persona all'organizzazione, nella direzione documentata.",
      pages: [
        page(
          "fixture-link-person",
          "Elena Verdi, persona fittizia",
          "Elena Verdi è dipendente della società fittizia Officina Lume dal 1 marzo 2026. Fonte: comunicato fittizio Lume C-4.",
          "person",
        ),
        page(
          "fixture-link-company",
          "Officina Lume, società fittizia",
          "Officina Lume è una società fittizia che produce lampade artigianali.",
          "client",
        ),
      ],
      focusPageIds: ["fixture-link-person", "fixture-link-company"],
      expected: {
        kind: "add_link",
        linkType: "works_at",
        preserve: ["1 marzo 2026", "C-4"],
      },
    },
    {
      id: "correction",
      description:
        "Correzione autorizzata da una fonte originale in una terza pagina senza link.",
      pages: [
        page(
          "fixture-correction-a",
          "Budget del progetto fittizio Iris: scheda A",
          "Il budget approvato del progetto fittizio Iris per il 2026 è 450 euro. Fonte dichiarata: verbale fittizio Iris V-12 del 2 settembre 2026.",
        ),
        page(
          "fixture-correction-b",
          "Budget del progetto fittizio Iris: scheda B",
          "Il budget approvato del progetto fittizio Iris per il 2026 è 4.500 euro. Fonte dichiarata: verbale fittizio Iris V-12 del 2 settembre 2026.",
        ),
        page(
          "fixture-correction-source",
          "Testo originale del verbale fittizio Iris V-12",
          "Verbale fittizio Iris V-12 del 2 settembre 2026, testo originale: «È approvato un budget di 4.500 euro per il progetto Iris per il 2026. La cifra 450 euro riportata nella scheda A è un errore di trascrizione e va corretta in 4.500 euro».",
        ),
      ],
      focusPageIds: ["fixture-correction-a", "fixture-correction-b"],
      expected: { kind: "reconcile", preserve: ["4.500", "2026", "V-12"] },
    },
    {
      id: "unresolved-conflict",
      description:
        "Fonti discordanti senza prova per scegliere una versione: nessuna correzione.",
      pages: [
        page(
          "fixture-conflict-a",
          "Capienza del teatro fittizio Quarzo, fonte A",
          "Secondo la perizia fittizia A del 5 settembre 2026, la sala unica del teatro Quarzo ha una capienza autorizzata di 80 persone al 5 settembre 2026.",
        ),
        page(
          "fixture-conflict-b",
          "Capienza del teatro fittizio Quarzo, fonte B",
          "Secondo la perizia fittizia B del 5 settembre 2026, la stessa sala unica del teatro Quarzo ha una capienza autorizzata di 100 persone al 5 settembre 2026. Non sono disponibili prove di rettifica o prevalenza di una perizia sull'altra.",
        ),
      ],
      focusPageIds: ["fixture-conflict-a", "fixture-conflict-b"],
      expected: { unresolved: true },
    },
    {
      id: "no-op",
      description: "Una singola informazione coerente: nessun intervento.",
      pages: [
        page(
          "fixture-noop",
          "Colore del prototipo fittizio Opale",
          "Il prototipo fittizio Opale è blu. Fonte: scheda tecnica fittizia O-1 del 10 settembre 2026.",
        ),
      ],
      focusPageIds: ["fixture-noop"],
      expected: {},
    },
  ];
}

/** Stage-isolation oracle, defined from the invented source facts before provider calls. */
export function fixtureGroundTruthPlan(
  fixture: ConsolidationFixture,
  snapshot: Snapshot,
): OperationPlan {
  const kind = fixture.expected.kind;
  if (!kind)
    throw new Error("This fixture has no ground-truth edit operation.");
  const targets = snapshot.units.filter((unit) =>
    fixture.focusPageIds.includes(unit.pageId),
  );
  const sourceId = "fixture-link-person";
  const targetId = "fixture-link-company";
  const selected =
    kind === "add_link"
      ? targets.filter((unit) => unit.pageId === sourceId)
      : targets;
  return {
    id: `synthetic-ground-truth:${fixture.id}:${snapshot.id}`,
    kind,
    findingIds: [`synthetic-ground-truth:${fixture.id}`],
    targetPageIds: kind === "add_link" ? [sourceId] : fixture.focusPageIds,
    targetUnitIds: selected.map((unit) => unit.id),
    evidenceUnitIds: snapshot.units.map((unit) => unit.id),
    readSet: snapshot.pages.map((page) => ({
      pageId: page.id,
      version: page.version,
    })),
    ...(kind === "deduplicate" || kind === "centralize"
      ? { retainedUnitId: targets[0].id, canonicalPageId: targets[0].pageId }
      : {}),
    ...(kind === "add_link"
      ? { link: { sourceId, targetId, type: "works_at" as const } }
      : {}),
    ...(kind === "reconcile"
      ? {
          resolution: "b" as const,
          correctionUnitIds: targets
            .filter((unit) => unit.pageId === "fixture-correction-a")
            .map((unit) => unit.id),
        }
      : {}),
    goal:
      kind === "deduplicate"
        ? "Keep the first complete occurrence of Aurora's opening hours with its date, weekday condition, holiday exception and R-7 source. Remove only the second exact duplicate."
        : kind === "centralize"
          ? "Merge all Faro budget, delivery date, responsible person and P-2 source details into the project page. Keep necessary context and a /pages/fixture-complementary-a reference in the reminder."
          : kind === "reconcile"
            ? "Correct only sheet A's erroneous 450 euro amount to 4.500 euro, as unequivocally established by original verbale Iris V-12 in the third source page. Preserve the 2026 scope, dates and V-12 source association."
            : "Add the documented works_at link from Elena Verdi to Officina Lume, preserving the direction and existing content.",
  };
}
