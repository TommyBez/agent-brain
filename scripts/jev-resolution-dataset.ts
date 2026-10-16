import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateDataset } from "./apo/dataset";
import type { Example } from "./apo/types";

/** Fresh fictional evidence, fixed before splitting or calling any model. */
const sources = [
  [
    "Tram Elara",
    "Il tram Elara passa ogni dieci minuti e termina il servizio alle 22.",
    "Il tram Elara passa ogni venti minuti e termina il servizio alle 20.",
  ],
  [
    "Portale Zircone",
    "Il portale Zircone accetta richieste solo firmate digitalmente.",
    "Il portale Zircone accetta richieste prive di firma digitale.",
  ],
  [
    "Deposito Vespro",
    "Il deposito Vespro custodisce i contenitori refrigerati al piano terra.",
    "Il deposito Vespro custodisce i contenitori refrigerati al secondo piano.",
  ],
  [
    "Palestra Estuario",
    "La palestra Estuario apre la sala pesi alle 7 e chiude alle 21.",
    "La palestra Estuario apre la sala pesi alle 9 e chiude alle 19.",
  ],
  [
    "Museo Aquilone",
    "Il museo Aquilone presta le opere soltanto a istituzioni pubbliche.",
    "Il museo Aquilone presta le opere anche a collezionisti privati.",
  ],
  [
    "Sportello Duna",
    "Lo sportello Duna riceve su appuntamento il martedì e il sabato.",
    "Lo sportello Duna riceve senza appuntamento soltanto il venerdì.",
  ],
  [
    "Rete Calcedonio",
    "La rete Calcedonio cifra tutti i messaggi prima di registrarli.",
    "La rete Calcedonio registra i messaggi in chiaro senza cifratura.",
  ],
  [
    "Officina Telero",
    "L'officina Telero include il controllo dei freni nella revisione ordinaria.",
    "L'officina Telero esclude il controllo dei freni dalla revisione ordinaria.",
  ],
  [
    "Campus Beccaccino",
    "Il campus Beccaccino assegna le stanze tramite una graduatoria annuale.",
    "Il campus Beccaccino assegna le stanze in ordine di prenotazione.",
  ],
  [
    "Giardino Astrale",
    "Il giardino Astrale permette l'ingresso dei cani tenuti al guinzaglio.",
    "Il giardino Astrale vieta l'ingresso di tutti i cani.",
  ],
  [
    "Catalogo Faggio Blu",
    "Il catalogo Faggio Blu conserva le edizioni esaurite tra i risultati di ricerca.",
    "Il catalogo Faggio Blu rimuove le edizioni esaurite dai risultati di ricerca.",
  ],
  [
    "Corriere Lince Bianca",
    "Il corriere Lince Bianca consegna i pacchi fragili soltanto al destinatario.",
    "Il corriere Lince Bianca può lasciare i pacchi fragili davanti alla porta.",
  ],
  [
    "Laboratorio Ninfea Rossa",
    "Il laboratorio Ninfea Rossa ripete ogni misura su tre campioni distinti.",
    "Il laboratorio Ninfea Rossa misura un solo campione per ciascuna prova.",
  ],
  [
    "Teatro Zefiro",
    "Il teatro Zefiro consente il cambio di data fino a quarantotto ore prima.",
    "Il teatro Zefiro vieta ogni cambio di data dopo l'acquisto.",
  ],
  [
    "Archivio Garzetta",
    "L'archivio Garzetta consegna le copie digitali entro cinque giorni lavorativi.",
    "L'archivio Garzetta consegna le copie digitali entro venti giorni lavorativi.",
  ],
  [
    "Mensa Sorbo Dorato",
    "La mensa Sorbo Dorato prepara un piatto vegetariano in ogni servizio.",
    "La mensa Sorbo Dorato prepara piatti vegetariani soltanto il mercoledì.",
  ],
  [
    "Sensore Perla Nera",
    "Il sensore Perla Nera invia un allarme sopra i quaranta gradi.",
    "Il sensore Perla Nera invia un allarme sopra i sessanta gradi.",
  ],
  [
    "Atelier Aliseo",
    "L'atelier Aliseo usa pigmenti ad acqua per tutti i manifesti.",
    "L'atelier Aliseo usa pigmenti a solvente per tutti i manifesti.",
  ],
  [
    "Biblioteca Topazio Verde",
    "La biblioteca Topazio Verde permette tre rinnovi consecutivi per ogni prestito.",
    "La biblioteca Topazio Verde permette un solo rinnovo per ogni prestito.",
  ],
  [
    "Fattoria Asteria",
    "La fattoria Asteria raccoglie le olive esclusivamente a mano.",
    "La fattoria Asteria raccoglie le olive esclusivamente con scuotitori meccanici.",
  ],
  [
    "Impianto Smeriglio",
    "L'impianto Smeriglio filtra l'acqua con due stadi indipendenti.",
    "L'impianto Smeriglio filtra l'acqua con un solo stadio.",
  ],
  [
    "Osservatorio Crisalide",
    "L'osservatorio Crisalide rende pubbliche le immagini dopo sette giorni.",
    "L'osservatorio Crisalide rende pubbliche le immagini dopo un anno.",
  ],
  [
    "Emporio Mirto Rosso",
    "L'emporio Mirto Rosso accetta pagamenti con carta anche per importi inferiori a cinque euro.",
    "L'emporio Mirto Rosso accetta soltanto contanti per importi inferiori a cinque euro.",
  ],
  [
    "Scuola Ametista",
    "La scuola Ametista organizza i corsi in gruppi di dodici allievi.",
    "La scuola Ametista organizza i corsi in gruppi di ventiquattro allievi.",
  ],
  [
    "Parcheggio Antares",
    "Il parcheggio Antares riserva il piano interrato ai veicoli elettrici.",
    "Il parcheggio Antares riserva il piano interrato alle motociclette.",
  ],
  [
    "Studio Cerfoglio",
    "Lo studio Cerfoglio consegna anche i file sorgenti al termine del lavoro.",
    "Lo studio Cerfoglio consegna solo i documenti esportati e trattiene i file sorgenti.",
  ],
  [
    "Piscina Azzurrite",
    "La piscina Azzurrite richiede la prenotazione per il nuoto libero.",
    "La piscina Azzurrite permette il nuoto libero senza prenotazione.",
  ],
  [
    "Consorzio Petalo",
    "Il consorzio Petalo assegna i contributi mediante estrazione tra le domande ammissibili.",
    "Il consorzio Petalo assegna i contributi secondo il punteggio delle domande.",
  ],
  [
    "Serra Andromeda",
    "La serra Andromeda irriga le colture due volte al giorno.",
    "La serra Andromeda irriga le colture una volta ogni tre giorni.",
  ],
  [
    "Auditorium Piuma",
    "L'auditorium Piuma ammette al massimo centottanta spettatori.",
    "L'auditorium Piuma ammette al massimo trecento spettatori.",
  ],
] as const;

function page(id: string, title: string, markdown: string) {
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
    links: [],
    updatedAt: id === "a" ? "2026-10-15T12:00:00Z" : "2026-09-01T12:00:00Z",
  };
}

export function generateResolutionDataset(): Example[] {
  const examples: Example[] = [];
  sources.forEach(([name, first, second], index) => {
    const group = `resolution-it-v2-${String(index).padStart(2, "0")}`;
    const pair = index % 2 === 0;
    const base = pair
      ? [
          page("a", `${name}: scheda`, first),
          page("b", `${name}: appunti`, second),
        ]
      : [page("a", name, `## Scheda\n${first}\n\n## Appunti\n${second}`)];
    const target = [first, second].map((text, position) => {
      const source = base[pair ? position : 0];
      const start = source.markdown.indexOf(text);
      return {
        id: `unit-${position}`,
        pageId: source.id,
        text,
        start,
        end: start + text.length,
        headings: [],
        context: source.markdown,
      };
    });
    function add(
      value: string,
      category: string,
      evidence: string | null,
      rationale: string,
    ) {
      examples.push({
        id: `${group}-${category}`,
        group,
        task: "resolution",
        language: "it",
        category,
        origin: "synthetic",
        state: {
          pages: [
            ...base,
            ...(evidence
              ? [page("source", `${name}: documentazione`, evidence)]
              : []),
          ],
          target,
        },
        pair,
        direct: pair && index % 3 === 0,
        direction: "ab",
        label: {
          value,
          method: "deterministic",
          source:
            "scripts/jev-resolution-dataset.ts: fonti fittizie e trasformazioni esplicite",
          version: "resolution-known-by-construction-v2",
          status: "constructed",
          confidence: null,
          agreement: null,
          models: [],
          rationale,
        },
      });
    }
    for (const value of ["a", "b"] as const) {
      const correct = value === "a" ? first : second;
      const incorrect = value === "a" ? second : first;
      const evidence =
        index % 3 === 0
          ? `Rettifica firmata relativa a ${name}: «${incorrect}» è un errore di trascrizione. Il testo originale corretto è «${correct}». Le due frasi riguardano esattamente lo stesso ambito e periodo; non si tratta di un cambiamento nel tempo.`
          : `Originale ufficiale di ${name}, riprodotto integralmente per il punto controverso: «${correct}». La frase «${incorrect}» deriva da una copia errata ed è espressamente smentita dall'originale. Stessa entità, stesso periodo, stesso ambito.`;
      add(
        value,
        `source-supports-${value}`,
        evidence,
        `L'originale incluso stabilisce la validità del passaggio ${value} e identifica esplicitamente l'altro come copia errata.`,
      );
    }
    add(
      "temporal",
      "successive-periods",
      `Il registro storico ufficiale di ${name} documenta due versioni successive. Fino al 31 dicembre 2024: «${first}». Dal 1 gennaio 2025: «${second}». I due passaggi vanno conservati assegnando a ciascuno il proprio periodo; il registro non denuncia errori nelle affermazioni.`,
      "La fonte inclusa dimostra una successione temporale e richiede di preservare entrambe le fasi.",
    );
    add(
      "scope",
      "simultaneous-scopes",
      `Il regolamento vigente di ${name} distingue due ambiti operativi contemporanei: nell'ambito Nord vale «${first}»; nell'ambito Sud vale «${second}». La differenza riguarda esclusivamente l'ambito, senza successione temporale né errori di trascrizione.`,
      "La fonte inclusa stabilisce ambiti distinti e contemporanei, quindi nessuna affermazione va eliminata.",
    );
    add(
      "insufficient",
      "referenced-source-absent",
      `Le due affermazioni di ${name} sono attribuite al documento originale identificato da https://example.invalid/risoluzione/${group}/registro. È questa la fonte specifica necessaria per decidere quale versione correggere. Del documento sono disponibili soltanto il riferimento e il titolo: il contenuto non è incluso nelle pagine.`,
      "È identificata una fonte risolutiva specifica che non è presente; il suo indirizzo non ne fornisce il contenuto.",
    );
    add(
      "none",
      "unsupported-no-reference",
      null,
      "Le due affermazioni sono incompatibili ma mancano fonti, prove di periodi o ambiti diversi e riferimenti a una specifica fonte risolutiva. Le date tecniche delle pagine non autorizzano una correzione.",
    );
  });
  return validateDataset(examples);
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("Specificare il percorso JSON di destinazione");
  const data = generateResolutionDataset();
  await writeFile(resolve(output), `${JSON.stringify(data, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    `${data.length} esempi italiani da ${sources.length} nuove famiglie di fonti`,
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
