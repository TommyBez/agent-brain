import type { Example } from "./types";

/** Fictional, independently written source families. All variants of a family stay together. */
const sources: ["it", string, string, string, string, string][] = [
  [
    "it",
    "Faro",
    "Faro conserva i backup per 21 giorni e li cifra prima del trasferimento.",
    "I salvataggi di Faro restano disponibili tre settimane; la cifratura precede l'invio.",
    "Faro conserva i backup per 90 giorni e non li cifra.",
    "Il ripristino viene provato ogni venerdì da una squadra separata.",
  ],
  [
    "it",
    "Ginestra",
    "Ginestra vende il piano annuale a 240 euro, imposte escluse, senza rinnovo automatico.",
    "L'abbonamento Ginestra dura dodici mesi, costa 240 euro più tasse e richiede un nuovo acquisto alla scadenza.",
    "Il piano annuale Ginestra costa 480 euro e si rinnova automaticamente.",
    "L'assistenza risponde mediante il portale clienti.",
  ],
  [
    "it",
    "Corallo",
    "La prova Corallo dura quattordici giorni e non richiede una carta di credito.",
    "Per due settimane si può provare Corallo senza fornire dati di pagamento.",
    "Per iniziare i sette giorni di prova Corallo è obbligatoria una carta.",
    "La documentazione comprende esempi in portoghese.",
  ],
  [
    "it",
    "Olmo",
    "Nel laboratorio Olmo entrano solo tecnici certificati, accompagnati durante il primo accesso.",
    "L'ingresso al laboratorio Olmo richiede certificazione tecnica e, la prima volta, un accompagnatore.",
    "Chiunque può accedere al laboratorio Olmo senza certificato o accompagnatore.",
    "Il magazzino dei ricambi occupa un edificio distinto.",
  ],
  [
    "it",
    "Brina",
    "La consegna Brina include il collaudo, ma esclude la formazione degli operatori.",
    "Il servizio Brina comprende le prove di accettazione; addestrare il personale resta fuori dal contratto.",
    "Brina include la formazione del personale ed esclude il collaudo.",
    "Il trasporto dei materiali avviene su mezzi elettrici.",
  ],
  [
    "it",
    "Cirmolo",
    "Il bilancio Cirmolo riporta 18 dipendenti a tempo pieno e nessun consulente esterno.",
    "Cirmolo impiega diciotto persone a tempo pieno; il bilancio non registra consulenti.",
    "Il bilancio Cirmolo registra 28 dipendenti e sei consulenti esterni.",
    "La relazione ambientale viene pubblicata separatamente.",
  ],
  [
    "it",
    "Quarzo",
    "Quarzo richiede due approvazioni per i rimborsi superiori a 500 euro.",
    "Oltre cinquecento euro, un rimborso Quarzo deve essere autorizzato da due persone.",
    "I rimborsi Quarzo sopra 500 euro non richiedono alcuna approvazione.",
    "Le ricevute vengono archiviate in ordine mensile.",
  ],
  [
    "it",
    "Loto",
    "Loto spedisce il lunedì e il giovedì; i prodotti refrigerati viaggiano soltanto il lunedì.",
    "Le partenze Loto sono due a settimana, lunedì e giovedì, con i refrigerati limitati al lunedì.",
    "Loto spedisce solo il venerdì, compresi i prodotti refrigerati.",
    "Il confezionamento usa scatole riutilizzabili.",
  ],
  [
    "it",
    "Selce",
    "Selce ha sospeso la campagna radio e mantiene attiva quella sulla stampa locale.",
    "La pubblicità radiofonica Selce è ferma; prosegue invece sui giornali del territorio.",
    "Selce mantiene attiva la campagna radio e ha sospeso quella sulla stampa locale.",
    "Il materiale fotografico è prodotto internamente.",
  ],
  [
    "it",
    "Amaranto",
    "Amaranto ammette gruppi di massimo otto visitatori e vieta fotografie con flash.",
    "Le visite Amaranto ospitano al più otto persone per gruppo; il flash non è consentito.",
    "Amaranto ammette gruppi di venti persone e permette il flash.",
    "La biglietteria si trova nel cortile esterno.",
  ],
  [
    "it",
    "Libellula",
    "Libellula offre sottotitoli in italiano e francese, ma non una traduzione audio.",
    "I video Libellula hanno testo sincronizzato italiano e francese; manca il doppiaggio tradotto.",
    "Libellula offre doppiaggio tradotto e nessun sottotitolo.",
    "Le lezioni vengono registrate in una sala insonorizzata.",
  ],
  [
    "it",
    "Rame",
    "Rame assegna il collaudo a una squadra indipendente da chi sviluppa il componente.",
    "Chi realizza il componente Rame non appartiene alla squadra che lo collauda.",
    "Rame affida il collaudo esclusivamente agli stessi sviluppatori del componente.",
    "L'inventario dei componenti usa etichette ottiche.",
  ],
  [
    "it",
    "Levante",
    "Levante accetta resi entro trenta giorni se il sigillo è intatto.",
    "Per restituire un acquisto Levante occorrono sigillo integro e non più di trenta giorni trascorsi.",
    "Levante non accetta resi, neppure entro trenta giorni con il sigillo intatto.",
    "La fattura viene inviata al momento della spedizione.",
  ],
  [
    "it",
    "Tiglio",
    "Tiglio registra la temperatura ogni dieci minuti e invia avvisi soltanto oltre 8 gradi.",
    "Il sensore Tiglio campiona sei volte l'ora e segnala superamenti degli 8 gradi.",
    "Tiglio registra ogni ora e avvisa quando la temperatura scende sotto zero.",
    "Il sensore è alimentato da una batteria sostituibile.",
  ],
  [
    "it",
    "Malva",
    "Malva raccoglie dati aggregati e non conserva gli indirizzi IP dei visitatori.",
    "Le statistiche Malva sono aggregate; gli IP di chi visita non vengono memorizzati.",
    "Malva conserva gli indirizzi IP e raccoglie solo dati individuali.",
    "Il rapporto di utilizzo è disponibile in formato CSV.",
  ],
  [
    "it",
    "Nibbio",
    "Nibbio consente agli editor di accedere alle bozze, ma riserva la pubblicazione ai revisori.",
    "Gli editor Nibbio possono leggere le bozze; soltanto i revisori hanno il permesso di pubblicarle.",
    "Ogni editor Nibbio può pubblicare, mentre ai revisori è vietato.",
    "Gli articoli archiviati rimangono ricercabili per titolo.",
  ],
  [
    "it",
    "Salice",
    "Il contributo Salice copre gli acquisti di attrezzature ed esclude viaggi e pernottamenti.",
    "Le attrezzature sono finanziabili con Salice; trasferte e alloggi restano a carico del richiedente.",
    "Salice finanzia viaggi e pernottamenti ma esclude le attrezzature.",
    "Le domande si presentano sul portale universitario.",
  ],
  [
    "it",
    "Ciottolo",
    "Ciottolo conserva i verbali di audit per sei anni e permette la lettura soltanto ai revisori.",
    "I verbali Ciottolo restano disponibili sei anni e possono essere letti esclusivamente dai revisori.",
    "Ciottolo elimina i verbali dopo un mese e li rende accessibili a chiunque.",
    "L’interfaccia degli audit si usa anche con la tastiera.",
  ],
  [
    "it",
    "Ginepro",
    "Ginepro spedisce gratuitamente i ricambi quando approva una richiesta in garanzia.",
    "Per le richieste in garanzia approvate, i componenti Ginepro vengono inviati senza spese di spedizione.",
    "Ginepro addebita la spedizione per ogni ricambio approvato in garanzia.",
    "Le istruzioni di montaggio sono incluse nel pacco.",
  ],
  [
    "it",
    "Falco",
    "Falco limita ogni caricamento a 15 megabyte e accetta PDF o testo semplice.",
    "I file inviati a Falco devono essere PDF o testo e non possono superare quindici megabyte.",
    "Falco accetta esclusivamente video di almeno 100 megabyte.",
    "I documenti caricati vengono indicizzati di notte.",
  ],
  [
    "it",
    "Ontano",
    "Il prototipo Ontano ha superato le prove al chiuso; le prestazioni all’aperto non sono state testate.",
    "Le prove interne di Ontano hanno avuto esito positivo, mentre il comportamento sul campo resta sconosciuto.",
    "Ontano ha fallito le prove al chiuso e superato tutte quelle all’aperto.",
    "Il suo involucro è prodotto in alluminio riciclato.",
  ],
  [
    "it",
    "Fringuello",
    "Fringuello assegna il 60 per cento del budget allo sviluppo e il 25 per cento all’assistenza.",
    "Lo sviluppo riceve tre quinti del budget Fringuello; all’assistenza spetta un quarto.",
    "Fringuello assegna il 25 per cento allo sviluppo e il 60 per cento all’assistenza.",
    "I responsabili rendicontano le spese ogni trimestre.",
  ],
  [
    "it",
    "Cedro",
    "Cedro annulla gratuitamente un ordine finché non comincia l’imballaggio.",
    "Prima dell’inizio dell’imballaggio, l’annullamento di un ordine Cedro non costa nulla.",
    "Cedro addebita sempre una penale di annullamento, anche prima dell’imballaggio.",
    "Le ricevute includono un riferimento univoco dell’ordine.",
  ],
  [
    "it",
    "Merlo",
    "Merlo richiede la supervisione di un adulto per chi partecipa e ha meno di sedici anni.",
    "I partecipanti a Merlo sotto i sedici anni devono essere accompagnati da un adulto responsabile.",
    "Merlo ammette minori di ogni età senza alcuna supervisione adulta.",
    "Le attività si svolgono nel laboratorio di quartiere.",
  ],
  [
    "it",
    "Nocciolo",
    "Nocciolo calcola i ricavi netti dopo gli sconti e senza includere le imposte sulle vendite.",
    "Il ricavo netto Nocciolo sottrae gli sconti e non comprende le imposte sulle vendite.",
    "Nocciolo include le imposte nei ricavi netti e non sottrae gli sconti.",
    "L’ufficio contabile pubblica una riconciliazione mensile.",
  ],
  [
    "it",
    "Scricciolo",
    "Scricciolo ritenta due volte gli invii falliti, poi passa l’elemento alla coda di revisione manuale.",
    "Dopo due nuovi tentativi senza successo, Scricciolo mette l’invio in attesa di revisione manuale.",
    "Scricciolo ritenta gli invii falliti senza limite e non richiede mai una revisione manuale.",
    "Ogni tentativo di invio riceve una marcatura temporale.",
  ],
  [
    "it",
    "Pioppo",
    "Il contratto Pioppo garantisce assistenza via email nei giorni feriali, escluse le festività.",
    "Pioppo assicura supporto contrattuale per posta elettronica dal lunedì al venerdì, salvo i festivi.",
    "Pioppo garantisce assistenza telefonica soltanto nei fine settimana e nei festivi.",
    "Il manuale del cliente elenca i contatti per le segnalazioni urgenti.",
  ],
  [
    "it",
    "Airone",
    "Airone cifra gli archivi esportati e invia le password attraverso un canale separato.",
    "Le esportazioni Airone sono cifrate; le loro password viaggiano indipendentemente dall’archivio.",
    "Airone esporta archivi non cifrati e include le password nello stesso messaggio.",
    "I nomi degli archivi comprendono il mese di esportazione.",
  ],
  [
    "it",
    "Sorbo",
    "Sorbo accetta risposte anonime ai questionari e non raccoglie recapiti.",
    "Chi compila i questionari Sorbo resta anonimo perché non vengono chiesti dati di contatto.",
    "Sorbo richiede nome completo e telefono a ogni partecipante al questionario.",
    "I risultati vengono pubblicati dopo la chiusura della raccolta.",
  ],
  [
    "it",
    "Rondone",
    "Rondone permette la lettura senza connessione, mentre la modifica richiede l’accesso alla rete.",
    "I documenti Rondone si leggono anche fuori rete; per cambiarli occorre essere online.",
    "Rondone richiede la connessione per leggere e consente modifiche soltanto fuori rete.",
    "Le miniature dei documenti vengono generate automaticamente.",
  ],
];

function page(
  id: string,
  title: string,
  markdown: string,
  links: {
    sourceId: string;
    targetId: string;
    type: string;
    label: string;
  }[] = [],
) {
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
function targets(pages: ReturnType<typeof page>[]) {
  return pages.slice(0, 2).map((p, index) => ({
    id: `unit-${index}`,
    pageId: p.id,
    start: 0,
    end: p.markdown.length,
    text: p.markdown,
    headings: [],
    context: p.markdown,
  }));
}

function passage(
  source: ReturnType<typeof page>,
  text: string,
  id: string,
  headings: string[] = [],
) {
  const start = source.markdown.indexOf(text);
  if (start < 0) throw new Error("Synthetic passage missing");
  return {
    id,
    pageId: source.id,
    start,
    end: start + text.length,
    text,
    headings,
    context: source.markdown,
  };
}

export function generateDataset(): Example[] {
  const examples: Example[] = [];
  sources.forEach(
    ([language, title, fact, paraphrase, contrary, detail], sourceIndex) => {
      const group = `source-${sourceIndex.toString().padStart(2, "0")}`;
      const it = language === "it";
      const pages = (a: string, b?: string) => [
        page("a", title, a),
        ...(b ? [page("b", `${title} dossier`, b)] : []),
      ];
      function add(
        task: Example["task"],
        category: string,
        value: string,
        state: Example["state"],
        rationale: string,
        pair = true,
        direct = false,
      ) {
        if (task === "link" && sourceIndex % 2 === 1) {
          const pairState = state as { pages: ReturnType<typeof page>[] };
          state = { pages: [...pairState.pages].reverse() };
        }
        examples.push({
          id: `${group}-${task}-${category}`,
          group,
          task,
          language,
          category,
          origin: "synthetic",
          state,
          pair,
          direction: task === "link" && sourceIndex % 2 === 1 ? "ba" : "ab",
          direct,
          label: {
            value,
            method: "deterministic",
            source:
              "apo/fixtures.ts: fictional source family and explicit construction rule",
            version: "known-by-construction-v1",
            status: "constructed",
            confidence: null,
            agreement: null,
            models: [],
            rationale,
          },
        });
      }
      add(
        "duplicate",
        "paraphrase",
        "true",
        { pages: pages(fact, paraphrase) },
        "Both passages restate the same multi-part fact; complementary detail must be retained.",
      );
      add(
        "duplicate",
        "within-page",
        "true",
        { pages: pages(`${fact}\n\n${detail}\n\n${paraphrase}`) },
        "One page repeats the source fact in two separate body passages.",
        false,
      );
      add(
        "duplicate",
        "complementary",
        "false",
        { pages: pages(fact, detail) },
        "The second passage adds a distinct fact and repeats no factual assertion.",
      );
      add(
        "conflict",
        "opposite-claims",
        "true",
        { pages: pages(fact, contrary) },
        "The assertions concern the same subject and directly disagree; a resolution is not required.",
      );
      add(
        "conflict",
        "equivalent-claims",
        "false",
        { pages: pages(fact, paraphrase) },
        "Equivalent wording asserts no incompatible fact.",
      );
      add(
        "conflict",
        "explicit-periods",
        "false",
        {
          pages: pages(
            `${it ? "Solo nel 2023" : "Only during 2023"}: ${fact}`,
            `${it ? "Regola dal 2025, che sostituisce esplicitamente quella del 2023" : "Rule from 2025, explicitly replacing the 2023 rule"}: ${contrary}`,
          ),
        },
        "The source already distinguishes successive periods, so no unresolved inconsistency remains.",
      );
      const citation = it
        ? `Il rapporto ${title} è citato come riferimento per il progetto.`
        : `The ${title} rapporto is explicitly cited as a project reference.`;
      const linkPages = [
        page("a", `${title} progetto`, citation),
        page("b", `${title} rapporto`, fact),
      ];
      add(
        "link",
        "explicit-reference",
        "true",
        { pages: linkPages },
        "The project explicitly references the unambiguous report and no outgoing edge exists.",
      );
      add(
        "link",
        "already-linked",
        "false",
        {
          pages: [
            {
              ...linkPages[0],
              links: [
                { sourceId: "a", targetId: "b", type: "references", label: "" },
              ],
            },
            linkPages[1],
          ],
        },
        "The exact useful directed reference already exists.",
      );
      add(
        "link",
        "shared-topic",
        "false",
        {
          pages: [
            page(
              "a",
              `${title} ricerca`,
              it
                ? `Una ricerca autonoma studia procedure simili a ${title}. Non cita né usa il rapporto e non documenta una relazione con esso.`
                : `An independent study explores procedures similar to ${title}. It neither cites nor uses the report and records no relationship to it.`,
            ),
            linkPages[1],
          ],
        },
        "Shared subject matter explicitly provides no relationship between these distinct documents.",
      );
      const diary = it
        ? `Nota dell'agente consolidatore: ho riordinato questa pagina e controllato i collegamenti. Nessun nuovo fatto su ${title}.`
        : `Consolidator agent log: I reorganized this page and checked its links. No new fact about ${title}.`;
      add(
        "residue",
        "activity-diary",
        "true",
        { pages: pages(`${fact}\n\n${diary}`) },
        "The separate paragraph records only the maintenance agent's activity.",
        false,
      );
      add(
        "residue",
        "original-request",
        "false",
        {
          pages: pages(
            `${fact}\n\n${it ? "Richiesta originale del proprietario" : "Original request from the owner"}: ${it ? `verificare il prossimo contratto di ${title} prima della firma.` : `review the next ${title} contract before signing.`}`,
          ),
        },
        "The follow-up is explicitly the original owner's request, not agent-invented work.",
        false,
      );
      add(
        "residue",
        "genuine-uncertainty",
        "false",
        {
          pages: pages(
            `${fact}\n\n${it ? `La fonte non chiarisce se ${title} estenderà questa regola; non c'è ancora una decisione documentata.` : `The source does not establish whether ${title} will extend this rule; no decision has been recorded.`}`,
          ),
        },
        "The text preserves genuine source uncertainty and creates no human task.",
        false,
      );
      const repeated = pages(`${fact}\n\n${paraphrase}`);
      add(
        "actionable",
        "redundant-body",
        "true",
        {
          pages: repeated,
          target: [
            passage(repeated[0], fact, "unit-0"),
            passage(repeated[0], paraphrase, "unit-1"),
          ],
        },
        "Two body passages on the same page duplicate substantive information; keeping it once is useful.",
        false,
        sourceIndex % 2 === 0,
      );
      const complementary = pages(fact, detail);
      add(
        "actionable",
        "complementary",
        "false",
        { pages: complementary, target: targets(complementary) },
        "The two target passages contain distinct information; putting them together is not deduplication.",
      );
      const summary = pages(
        `${it ? "# Riepilogo utile per orientarsi" : "# Useful navigation summary"}\n${fact}\n\n${it ? "# Dettagli" : "# Details"}\n${paraphrase}\n${detail}`,
      );
      add(
        "actionable",
        "useful-summary",
        "false",
        {
          pages: summary,
          target: [
            passage(summary[0], fact, "unit-0", ["Riepilogo"]),
            passage(summary[0], paraphrase, "unit-1", ["Dettagli"]),
          ],
        },
        "A useful local introduction and its detail section have distinct functions; repeating a fact here is not a useful deletion.",
        false,
      );
      const conflicting = pages(fact, contrary);
      const sourcePrefix = it
        ? `Trascrizione verificata della specifica ufficiale vigente di ${title}, stessa entità, stesso ambito e periodo. Il passaggio incompatibile è un errore di trascrizione. Testo della fonte: `
        : `Verified transcript of the current official ${title} specification, same entity, scope and period. The incompatible passage is a transcription error. Source text: `;
      for (const [value, original] of [
        ["a", fact],
        ["b", contrary],
      ] as const)
        add(
          "resolution",
          `source-supports-${value}`,
          value,
          {
            pages: [
              ...conflicting,
              page("source", "Specifica originale", sourcePrefix + original),
            ],
            target: targets(conflicting),
          },
          `The supplied authoritative transcript explicitly establishes target[${value === "a" ? 0 : 1}] and identifies the other as a transcription error.`,
          true,
          sourceIndex % 2 === 0,
        );
      add(
        "resolution",
        "temporal-evidence",
        "temporal",
        {
          pages: [
            ...conflicting,
            page(
              "source",
              "Cronologia delle versioni",
              it
                ? `Archivio ufficiale: fino al 2023 valeva «${fact}»; dal 2025 è in vigore «${contrary}».`
                : `Official history: until 2023, "${fact}" applied; since 2025, "${contrary}" applies.`,
            ),
          ],
          target: targets(conflicting),
        },
        "Source evidence assigns the two assertions to successive periods; retain both with their dates.",
      );
      add(
        "resolution",
        "scope-evidence",
        "scope",
        {
          pages: [
            ...conflicting,
            page(
              "source",
              "Specifiche per ambito",
              it
                ? `Specifica ufficiale: per l'edizione italiana vale «${fact}»; per l'edizione canadese vale «${contrary}». Entrambe sono attuali.`
                : `Official specification: the UK edition follows "${fact}"; the Canadian edition follows "${contrary}". Both are current.`,
            ),
          ],
          target: targets(conflicting),
        },
        "The original specification establishes different scopes; do not discard either assertion.",
      );
      add(
        "resolution",
        "source-missing",
        "insufficient",
        {
          pages: [
            ...conflicting,
            page(
              "source",
              "Fonte non disponibile",
              it
                ? `Solo il documento https://example.invalid/${title.toLowerCase()}/official può risolvere il contrasto. Il suo contenuto non è incluso.`
                : `Only https://example.invalid/${title.toLowerCase()}/official can resolve this disagreement. Its contents are not supplied.`,
            ),
          ],
          target: targets(conflicting),
        },
        "A specific resolving source is referenced but absent; the URL alone supplies no contents.",
      );
      add(
        "resolution",
        "unsupported",
        "none",
        { pages: conflicting, target: targets(conflicting) },
        "No source, period or scope evidence is available to authorize choosing a winner or clarifying the disagreement.",
      );
    },
  );
  return examples;
}
