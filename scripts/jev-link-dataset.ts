import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LinkType } from "../lib/brain/types";
import { validateDataset } from "./apo/dataset";
import type { Example } from "./apo/types";

/** New fictional sources, constructed before splitting; no previous test errors are reused. */
const families = [
  [
    "Acquamarina",
    "Dora Gentili",
    "Arcipelago",
    "Il laboratorio misura la salinità nelle vasche di acquacoltura.",
  ],
  [
    "Balestra",
    "Elio Romani",
    "Quadrante",
    "La società costruisce banchi di collaudo per freni ferroviari.",
  ],
  [
    "Calesse",
    "Vera Landi",
    "Mosaico",
    "L'officina restaura carrozze con ricambi prodotti su disegno.",
  ],
  [
    "Darsena",
    "Nino Fabbri",
    "Sestante",
    "Il cantiere ripara piccole imbarcazioni nella darsena comunale.",
  ],
  [
    "Edera Blu",
    "Lia Rinaldi",
    "Orizzonte",
    "Il vivaio coltiva piante aromatiche per i giardini scolastici.",
  ],
  [
    "Fonderia Est",
    "Marta Benassi",
    "Crogiolo",
    "La fonderia recupera gli sfridi per produrre nuovi stampi.",
  ],
  [
    "Gelso Alto",
    "Arturo Fontani",
    "Pergamena",
    "La cooperativa digitalizza registri notarili su supporti fragili.",
  ],
  [
    "Isola Corta",
    "Nora Guidi",
    "Lanterna",
    "L'associazione organizza spettacoli di ombre nelle biblioteche.",
  ],
  [
    "Lamina Verde",
    "Ivo Moretti",
    "Tracciato",
    "L'impresa taglia lamiere sottili per strumenti musicali.",
  ],
  [
    "Marea Chiara",
    "Sonia Lenti",
    "Bussola",
    "Il centro marino cataloga le segnalazioni di specie invasive.",
  ],
  [
    "Neviera",
    "Luca Ferretti",
    "Pendio",
    "La stazione registra lo spessore della neve sulle piste chiuse.",
  ],
  [
    "Onda Lunga",
    "Eva Bellini",
    "Accordo",
    "Lo studio registra cori usando microfoni riparabili.",
  ],
  [
    "Pietra Rosa",
    "Aldo Venturi",
    "Volta",
    "L'atelier ricostruisce mosaici con tessere di recupero.",
  ],
  [
    "Rivolo",
    "Sara Neri",
    "Confluenza",
    "Il consorzio distribuisce l'acqua irrigua tramite turni prenotati.",
  ],
  [
    "Spiga Alta",
    "Bruno Sarti",
    "Covone",
    "Il mulino macina piccole partite di cereali locali.",
  ],
  [
    "Tessitura Nova",
    "Dina Carli",
    "Ordito",
    "La manifattura tesse campioni di lino per archivi tessili.",
  ],
  [
    "Urna Rossa",
    "Piero Milani",
    "Argilla",
    "La bottega prepara smalti senza piombo per ceramiche d'uso.",
  ],
  [
    "Vetta Piana",
    "Alma Conti",
    "Sentiero",
    "Il rifugio tiene un registro delle condizioni dei sentieri.",
  ],
  [
    "Zaffiro Opaco",
    "Remo Rizzi",
    "Prisma",
    "Il centro ottico calibra filtri per telescopi didattici.",
  ],
  [
    "Corte Bianca",
    "Flora Greco",
    "Portico",
    "La fondazione rende accessibili cortili storici mediante visite guidate.",
  ],
] as const;

type Edge = {
  sourceId: string;
  targetId: string;
  type: LinkType;
  label: string;
};
function page(id: string, title: string, markdown: string, links: Edge[] = []) {
  return {
    id,
    slug: id,
    title,
    markdown,
    type: "note",
    summary: "",
    relationships: [],
    aliases: [],
    tags: [],
    links,
  };
}

export function generateLinkDataset(): Example[] {
  const examples: Example[] = [];
  families.forEach(([company, person, project, context], index) => {
    const group = `relations-it-v2-${String(index).padStart(2, "0")}`;
    const report = `Relazione tecnica ${project}`;
    const cases: [string, LinkType, ReturnType<typeof page>[]][] = [
      [
        "source-reference",
        "references",
        [
          page(
            "a",
            project,
            `${context} Il progetto ${project} usa come riferimento la relazione tecnica omonima.`,
          ),
          page(
            "b",
            report,
            `Il documento descrive le verifiche del progetto ${project}. ${context}`,
          ),
        ],
      ],
      [
        "target-employment",
        "works_at",
        [
          page(
            "a",
            person,
            `${person} è una persona identificata univocamente in questo archivio. La sua scheda raccoglie competenze tecniche.`,
          ),
          page(
            "b",
            company,
            `${context} ${company} impiega ${person} come dipendente nel proprio ufficio tecnico.`,
          ),
        ],
      ],
      [
        "target-ownership",
        "owns",
        [
          page(
            "a",
            company,
            `${company} è l'organizzazione descritta in questa scheda. ${context}`,
          ),
          page(
            "b",
            project,
            `Il progetto ${project} è di proprietà esclusiva di ${company}, che ne possiede tutti i diritti. Il responsabile operativo è ${person}.`,
          ),
        ],
      ],
      [
        "source-dependency",
        "depends_on",
        [
          page(
            "a",
            project,
            `${context} Il funzionamento del progetto ${project} dipende necessariamente dal servizio Cartografia ${project}. Senza quel servizio non può operare.`,
          ),
          page(
            "b",
            `Cartografia ${project}`,
            `Il servizio fornisce mappe aggiornate al progetto ${project} ed è gestito da ${company}.`,
          ),
        ],
      ],
    ];
    function add(
      category: string,
      value: boolean,
      pages: ReturnType<typeof page>[],
      rationale: string,
    ) {
      const reverse = index % 2 === 1;
      examples.push({
        id: `${group}-${category}`,
        group,
        task: "link",
        language: "it",
        category,
        origin: "synthetic",
        state: { pages: reverse ? [...pages].reverse() : pages },
        pair: true,
        direction: reverse ? "ba" : "ab",
        direct: false,
        label: {
          value: String(value),
          method: "deterministic",
          source:
            "scripts/jev-link-dataset.ts: relazioni fittizie costruite esplicitamente",
          version: "relations-known-by-construction-v2",
          status: "constructed",
          confidence: null,
          agreement: null,
          models: [],
          rationale,
        },
      });
    }
    for (const [category, type, pages] of cases) {
      add(
        category,
        true,
        pages,
        `Le pagine documentano esplicitamente la relazione ${type} dalla sorgente alla destinazione; il collegamento manca. La prova può trovarsi nella destinazione.`,
      );
      add(
        `${category}-existing`,
        false,
        [
          {
            ...pages[0],
            links: [{ sourceId: "a", targetId: "b", type, label: "" }],
          },
          pages[1],
        ],
        "Il collegamento diretto corrispondente alla relazione documentata è già presente nella sorgente.",
      );
    }
    add(
      "shared-topic",
      false,
      [
        page(
          "a",
          `${project} appunti`,
          `${context} Questi appunti descrivono un'iniziativa autonoma, senza collaborazioni o dipendenze con altre iniziative.`,
        ),
        page(
          "b",
          `${company} rassegna`,
          `La rassegna tratta in generale lo stesso settore. Non cita gli appunti ${project}, non li usa e non documenta una relazione specifica con essi.`,
        ),
      ],
      "Le due pagine condividono soltanto l'argomento; non esiste una relazione specifica documentata.",
    );
    add(
      "different-entity",
      false,
      [
        page(
          "a",
          project,
          `Il progetto ${project} fa riferimento a una vecchia azienda chiamata ${company}, chiusa nel 1990.`,
        ),
        page(
          "b",
          company,
          `${company} è stata fondata nel 2020. Non è la società omonima chiusa nel 1990, non ne è successore e non ha rapporti con essa. ${context}`,
        ),
      ],
      "Il riferimento riguarda un'entità esplicitamente diversa dalla destinazione, nonostante l'omonimia.",
    );
  });
  return validateDataset(examples);
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("Specificare il percorso JSON di destinazione");
  const data = generateLinkDataset();
  await writeFile(resolve(output), `${JSON.stringify(data, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    `${data.length} esempi italiani da ${families.length} nuove famiglie di fonti`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Generazione fallita",
    );
    process.exitCode = 1;
  });
