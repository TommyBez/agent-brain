import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LinkType } from "../lib/brain/types";
import { evidencePage } from "../lib/maintenance/consolidator/projections";
import { validateDataset } from "./apo/dataset";
import type { Example } from "./apo/types";
import { fixturePage } from "./jev-missing-dataset";

const sources = [
  [
    "Associazione Corniola",
    "restaura lanterne ferroviarie con ricambi certificati",
    "sala delle locomotive",
  ],
  [
    "Centro Zafferano",
    "distribuisce libri illustrati ai reparti pediatrici",
    "auditorium del quartiere",
  ],
  [
    "Circolo Ametrina",
    "organizza lezioni di navigazione con carte nautiche cartacee",
    "pontile del lago",
  ],
  [
    "Fondazione Ginepro Bianco",
    "custodisce fotografie aeree in contenitori senza acidi",
    "archivio municipale",
  ],
  [
    "Società Limonio",
    "ripara mulini ad acqua con componenti di legno locale",
    "cortile del mulino",
  ],
  [
    "Gruppo Diaspro Verde",
    "insegna a realizzare strumenti a fiato con canne stagionate",
    "laboratorio della musica",
  ],
  [
    "Officina Crespino",
    "costruisce rastrelliere smontabili per le biciclette cargo",
    "piazza della stazione",
  ],
  [
    "Cooperativa Rodolite",
    "produce quaderni usando carta recuperata dagli uffici",
    "magazzino della cartiera",
  ],
  [
    "Istituto Cedrina",
    "cataloga le varietà di pomodori coltivate negli orti scolastici",
    "giardino botanico",
  ],
  [
    "Museo Iolite",
    "conserva bussole storiche in vetrine a umidità controllata",
    "galleria degli strumenti",
  ],
  [
    "Biblioteca Frassino Dorato",
    "presta dizionari tattili agli studenti di lingue",
    "aula dei seminari",
  ],
  [
    "Laboratorio Celestina",
    "ripara orologi solari ricostruendo le indicazioni mancanti",
    "terrazza meridionale",
  ],
  [
    "Consorzio Camedrio",
    "trasporta il raccolto usando cassette ventilate riutilizzabili",
    "mercato coperto",
  ],
  [
    "Teatro Selenite",
    "prepara scenografie modulari con pannelli di sughero",
    "foyer del teatro",
  ],
  [
    "Scuola Cicerchia",
    "insegna a intrecciare cestini con fibre di salice",
    "sala dell'artigianato",
  ],
  [
    "Parco Rame Rosso",
    "protegge gli stagni attraverso passerelle sopraelevate",
    "centro visitatori",
  ],
  [
    "Archivio Calcedonio",
    "digitalizza spartiti mantenendo la numerazione originale",
    "sala dei manoscritti",
  ],
  [
    "Palestra Fiordaliso",
    "offre percorsi motori con segnali luminosi per gli allievi sordi",
    "salone degli allenamenti",
  ],
  [
    "Emporio Tulipano Nero",
    "ripara borse di tessuto per prolungarne il riutilizzo",
    "bottega del borgo",
  ],
  [
    "Serra Spinello",
    "conserva semi alpini in vasetti con etichette resistenti all'acqua",
    "padiglione delle sementi",
  ],
] as const;

/** Fresh Italian families plus event-canonical and existing-edge counterexamples, authored before test access. */
export function generateContractDataset(): Example[] {
  const rows: Example[] = [];
  for (const [index, [name, activity, venue]] of sources.entries()) {
    const group = `contract-it-v1-${String(index).padStart(2, "0")}`;
    const add = (
      task: "destination" | "relation" | "duplicate" | "residue",
      category: string,
      state: unknown,
      label: string,
      pair = true,
    ) =>
      rows.push({
        id: `${group}-${task}-${category}`,
        group,
        task,
        language: "it",
        category,
        origin: "synthetic",
        state: JSON.parse(JSON.stringify(state)),
        pair,
        direction: "ab",
        direct: false,
        label: {
          value: label,
          method: "deterministic",
          source:
            "scripts/jev-contract-dataset.ts: ruoli e relazioni espliciti",
          version: "contract-known-by-construction-v1",
          status: "constructed",
          confidence: null,
          agreement: null,
          models: [],
          rationale:
            "Il ruolo della pagina rispetto al fatto e la presenza del collegamento sono espliciti. Nessun esito di test precedente determina questa etichetta.",
        },
      });
    const fact = `${name} ${activity}.`;
    const event = `La presentazione annuale di ${name} si tiene il ${index + 1} novembre 2026 presso ${venue}.`;
    const pairState = (
      a: string,
      b: string,
      aTitle: string = name,
      bTitle: string = name,
    ) => ({
      pages: [fixturePage("a", aTitle, a), fixturePage("b", bTitle, b)].map(
        evidencePage,
      ),
    });
    add(
      "duplicate",
      "same-subject",
      pairState(fact, `Attività documentata: ${fact}`),
      "true",
    );
    add(
      "duplicate",
      "different-page-subjects-shared-fact",
      pairState(
        `Questa pagina riguarda esclusivamente il progetto didattico, non il reparto amministrativo. Il fornitore comune è documentato così: ${fact}`,
        `Questa pagina riguarda esclusivamente il reparto amministrativo, non il progetto didattico. Il fornitore comune è documentato così: ${fact}`,
        `Progetto didattico di ${name}`,
        `Reparto amministrativo di ${name}`,
      ),
      "true",
    );
    add("duplicate", "complementary", pairState(fact, event), "false");
    add(
      "duplicate",
      "distinct-homonym",
      pairState(
        fact,
        `Questa scheda riguarda un ente omonimo distinto da quello dell'altra pagina. Solo questo secondo ente è descritto qui: ${fact}`,
      ),
      "false",
    );
    add(
      "duplicate",
      "within-page-repetition",
      {
        pages: [
          evidencePage(
            fixturePage("a", name, `${fact}\n\nAttività documentata: ${fact}`),
          ),
        ],
      },
      "true",
      false,
    );
    add(
      "duplicate",
      "within-page-complementary",
      { pages: [evidencePage(fixturePage("a", name, `${fact}\n\n${event}`))] },
      "false",
      false,
    );
    const residueCases: [string, string, string][] = [
      [
        "explicit-agent-diary",
        `Nota del consolidatore: ho controllato la pagina di ${name} e salvato il risultato.`,
        "true",
      ],
      [
        "mixed-agent-diary",
        `Nota del consolidatore: ho riordinato la pagina. ${fact}`,
        "true",
      ],
      [
        "agent-followup",
        `Richiesta aggiunta dal consolidatore senza una richiesta originale: il proprietario deve confermare il regolamento di ${name}.`,
        "true",
      ],
      [
        "useful-citation",
        `Fonte originale per la descrizione di ${name}: [registro annuale](https://example.invalid/${group}/registro). Estratto: «${fact}»`,
        "false",
      ],
      [
        "original-owner-request",
        `Richiesta originale del proprietario: verificare l'orario della presentazione di ${name}.`,
        "false",
      ],
      [
        "subject-uncertainty",
        `Non è ancora noto se ${name} aprirà una seconda sede; il registro non riporta una decisione.`,
        "false",
      ],
      [
        "human-completed-work",
        `Il responsabile di ${name} ha completato il controllo dell'impianto elettrico e firmato il verbale.`,
        "false",
      ],
      [
        "human-first-person-source",
        `Testimonianza originale del responsabile di ${name}: «Ho controllato l'impianto elettrico e completato la riparazione dei cavi».`,
        "false",
      ],
      [
        "agent-added-useful-source",
        `Fonte aggiunta dal consolidatore a supporto del fatto: [registro originale](https://example.invalid/${group}/fonte). Il registro afferma: «${fact}»`,
        "false",
      ],
      ["subject-facts-only", fact, "false"],
    ];
    for (const [category, text, label] of residueCases)
      add(
        "residue",
        category,
        { pages: [evidencePage(fixturePage("a", name, text))] },
        label,
        false,
      );
    const destination = (
      category: string,
      claim: string,
      aRole: string,
      bRole: string,
      label: string,
    ) => {
      const pages = [
        fixturePage("a", `${name}: documento A`, `${aRole}\n\n${claim}`),
        fixturePage("b", `${name}: documento B`, `${bRole}\n\n${claim}`),
      ];
      add(
        "destination",
        category,
        {
          pages: pages.map(evidencePage),
          target: pages.map((p, i) => ({
            id: `target-${i}`,
            pageId: p.id,
            text: claim,
            start: p.markdown.indexOf(claim),
            end: p.markdown.indexOf(claim) + claim.length,
            headings: [],
            context: p.markdown,
          })),
        },
        label,
      );
    };
    const stable = `Scheda ufficiale dedicata alla descrizione stabile di ${name}.`;
    const incidental = `Promemoria di un evento temporaneo. La descrizione stabile di ${name} appartiene alla scheda dedicata e qui viene riportata solo incidentalmente.`;
    destination("stable-a", fact, stable, incidental, "a");
    destination("stable-b", fact, incidental, stable, "b");
    destination("stable-equivalent", fact, stable, stable, "equivalent");
    destination("no-stable-home", fact, incidental, incidental, "none");
    const canonicalEvent = `Pagina canonica della presentazione annuale di ${name}, dedicata al luogo e alla data di questo specifico evento.`;
    const copiedEvent = `Promemoria personale della stessa presentazione. Per luogo e data il riferimento canonico è la pagina dedicata dell'evento.`;
    destination("event-a", event, canonicalEvent, copiedEvent, "a");
    destination("event-b", event, copiedEvent, canonicalEvent, "b");
    destination(
      "event-equivalent",
      event,
      canonicalEvent,
      canonicalEvent,
      "equivalent",
    );
    destination(
      "event-over-subject-a",
      event,
      canonicalEvent,
      `Scheda stabile di ${name}; il luogo e la data dell'evento sono riportati incidentalmente e appartengono alla pagina dell'evento.`,
      "a",
    );
    destination(
      "event-over-subject-b",
      event,
      `Scheda stabile di ${name}; il luogo e la data dell'evento sono riportati incidentalmente e appartengono alla pagina dell'evento.`,
      canonicalEvent,
      "b",
    );
    destination(
      "neither-event-home",
      event,
      `Registro dei materiali utilizzati. Non è una scheda dell'evento; luogo e data appartengono al programma ufficiale esterno a queste due pagine.`,
      `Registro dei partecipanti. Non è una scheda dell'evento; luogo e data appartengono al programma ufficiale esterno a queste due pagine.`,
      "none",
    );

    const sourceNames: Record<LinkType, string> = {
      works_at: `Referente di ${name}`,
      owns: name,
      part_of: name,
      relates_to: name,
      decided_in: `Decisione di ${name} sulle visite`,
      references: `Scheda operativa di ${name}`,
      depends_on: `Servizio di ${name}`,
      supersedes: `Procedura corrente di ${name}`,
      collaborates_with: name,
    };
    const targetNames: Record<LinkType, string> = {
      works_at: `Ente ospitante di ${name}`,
      owns: `Edificio amministrativo di ${name}`,
      part_of: `Rete territoriale di ${name}`,
      relates_to: `Vicino di ingresso di ${name}`,
      decided_in: `Riunione di approvazione di ${name}`,
      references: `Manuale tecnico di ${name}`,
      depends_on: `Fornitura necessaria a ${name}`,
      supersedes: `Procedura precedente di ${name}`,
      collaborates_with: `Partner autonomo di ${name}`,
    };
    for (const type of Object.keys(sourceNames) as LinkType[]) {
      const a = sourceNames[type],
        b = targetNames[type];
      const evidence: Record<LinkType, string> = {
        works_at: `${a} lavora presso ${b}.`,
        owns: `${a} possiede ${b} come bene patrimoniale.`,
        part_of: `${a} è un reparto costitutivo di ${b}.`,
        relates_to: `${a} e ${b} condividono il cortile di accesso; la vicinanza è utile per orientarsi. Non sono documentati rapporti di lavoro, proprietà, dipendenza o appartenenza.`,
        decided_in: `${a} è stata adottata durante ${b}.`,
        references: `${a} cita espressamente ${b} come documento di approfondimento.`,
        depends_on: `${a} richiede ${b} per poter funzionare; in sua assenza il servizio si arresta.`,
        supersedes: `${a} sostituisce integralmente ${b}, che è stata ritirata.`,
        collaborates_with: `${a} e ${b} collaborano come enti autonomi al medesimo progetto.`,
      };
      const pages = [
        fixturePage("a", a, evidence[type]),
        fixturePage("b", b, `Scheda relativa a ${b}. ${fact}`),
      ];
      if (type === "works_at") {
        pages[0].type = "person";
        pages[1].type = "company";
      }
      if (type === "decided_in") pages[0].type = "decision";
      add(
        "relation",
        `missing-${type}`,
        { source: evidencePage(pages[0]), target: evidencePage(pages[1]) },
        type,
      );
      const existing = structuredClone(pages);
      existing[0].links = [
        {
          id: "edge",
          sourceId: "a",
          targetId: "b",
          type,
          label: "Collegamento già presente",
        },
      ];
      add(
        "relation",
        `existing-${type}`,
        {
          source: evidencePage(existing[0]),
          target: evidencePage(existing[1]),
        },
        "none",
      );
      if (type !== "references") {
        const targetEvidence = structuredClone(pages);
        targetEvidence[0].markdown = `Scheda relativa a ${a}. ${fact}`;
        targetEvidence[1].markdown = evidence[type];
        add(
          "relation",
          `target-evidence-${type}`,
          {
            source: evidencePage(targetEvidence[0]),
            target: evidencePage(targetEvidence[1]),
          },
          type,
        );
      }
    }
    add(
      "relation",
      "topic-only",
      {
        source: evidencePage(fixturePage("a", name, fact)),
        target: evidencePage(
          fixturePage(
            "b",
            `Ente omonimo distinto da ${name}`,
            `Questo ente è distinto da ${name} e opera nello stesso settore; non è documentato alcun rapporto fra i due.`,
          ),
        ),
      },
      "none",
    );
  }
  assert.equal(rows.length, 1060);
  return validateDataset(rows);
}
async function main() {
  const out = process.argv[2];
  assert(out, "Specificare il file JSON di destinazione");
  const data = generateContractDataset();
  await writeFile(resolve(out), `${JSON.stringify(data, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    `${data.length} casi italiani, 20 nuove famiglie: destinazione, tipo di relazione, duplicati e residui.`,
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
