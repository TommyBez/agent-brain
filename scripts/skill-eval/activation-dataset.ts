import { type Scenario, scenarios } from "./dataset";

// Independent of decision-routing fixtures: requests do not receive a save prefix.
const initial = structuredClone(scenarios.find((c) => c.id === "D10")?.initial);
if (!initial) throw new Error("Missing initial context fixture");
const project = initial.find((p) => p.type === "project");
if (!project) throw new Error("Missing project fixture");
project.aliases = [...new Set([...project.aliases, "Iris"])];
const holdout = new Set(["A05", "A08", "A10", "A16", "A18", "A20"]);

function activation(
  id: string,
  category: NonNullable<Scenario["activation"]>["category"],
  request: string,
  rationale: string,
  content: string,
): Scenario {
  return {
    id,
    group: holdout.has(id) ? "holdout" : "development",
    request,
    initial: structuredClone(initial ?? []),
    activation: {
      shouldActivate: category !== "negative",
      category,
      rationale,
    },
    expected: {
      newDecisions: 0,
      updatedIds: [],
      noMutations: true,
      links: [],
      content: [content, "Non modificare le pagine senza autorizzazione."],
    },
  };
}

/** Labels and rationales are grader-only. Freeze before any model executions. */
export const activationScenarios: Scenario[] = [
  activation(
    "A01",
    "explicit",
    "Usa la skill brain-memory per ricordarmi chi segue Portale Iris. Non modificare nulla.",
    "Invocazione esplicita: controllo positivo del caricamento.",
    "Risponde Marta sulla base del progetto recuperato.",
  ),
  activation(
    "A02",
    "retrieval",
    "Domani vedo Studio Selva per Portale Iris. Preparami un breve promemoria con i vincoli e le scelte già concordate.",
    "Il promemoria richiede contesto personale già conservato.",
    "Recupera responsabile, lingua italiana e hosting gestito, senza dichiarare implementazione completata.",
  ),
  activation(
    "A03",
    "retrieval",
    "Devo rispondere al team di Portale Iris sull'hosting. Quale approccio avevamo scelto e perché?",
    "Richiesta implicita di recuperare una decisione precedente.",
    "Recupera hosting gestito, limite operativo del team e costo maggiore accettato.",
  ),
  activation(
    "A04",
    "retrieval",
    "Abbozza una proposta per proseguire Portale Iris rispettando i vincoli che abbiamo già definito. Prima recupera quel contesto.",
    "La proposta dipende da vincoli del progetto non presenti nella richiesta.",
    "Usa contesto recuperato e distingue proposte nuove da fatti già concordati.",
  ),
  activation(
    "A05",
    "retrieval",
    "Chi è la persona responsabile di Portale Iris? Devo capire con chi parlarne.",
    "La domanda richiede un fatto sul mondo dell'utente.",
    "Indica Marta senza inventare recapiti o incarichi ulteriori.",
  ),
  activation(
    "A06",
    "memory",
    "Per Portale Iris abbiamo deciso che la prima versione servirà soltanto studi professionali, escludendo le catene di negozi. Tienine conto nel ragionamento: quali conseguenze ha sul prodotto?",
    "Una scelta adottata emersa durante un altro compito merita valutazione come memoria; la richiesta non autorizza un salvataggio persistente.",
    "Valuta il valore della nuova decisione e ne discute le conseguenze senza salvarla autonomamente.",
  ),
  activation(
    "A07",
    "memory",
    "Da oggi la responsabile di Portale Iris è Elena, che sostituisce Marta. Mi aiuti a preparare una lista breve per il passaggio di consegne?",
    "Il cambio di responsabilità è un fatto durevole emerso durante la preparazione di un documento.",
    "Valuta l'aggiornamento di responsabilità come memoria e prepara la lista, senza attribuire a Elena dettagli non forniti.",
  ),
  activation(
    "A08",
    "memory",
    "Studio Selva vuole d'ora in poi tutti i report in italiano e in formato PDF. Come organizzeresti il prossimo aggiornamento al cliente?",
    "Una preferenza stabile del cliente merita valutazione per usi futuri.",
    "Distingue la nuova preferenza del cliente da una scelta occasionale, senza scrivere senza autorizzazione.",
  ),
  activation(
    "A09",
    "explicit",
    "Salva questa decisione per Portale Iris: useremo PostgreSQL come database principale. È una scelta approvata, ma non abbiamo ancora iniziato la migrazione.",
    "La richiesta autorizza una scrittura di memoria, senza nominare la skill.",
    "Crea la decisione PostgreSQL collegata a Portale Iris; non dichiara completata la migrazione.",
  ),
  activation(
    "A10",
    "memory",
    "Stavamo discutendo in generale di report. Ora una novità sul mio progetto Portale Iris: ho deciso di rimandare la dashboard finché l'export non sarà pronto. Mi aiuti a spiegare questo ordine al team?",
    "Il bisogno di memoria emerge nel contesto di un compito diverso; non è necessario nominare Brain.",
    "Valuta la nuova priorità come candidata alla memoria e prepara una spiegazione senza inventare motivazioni.",
  ),
  activation(
    "A11",
    "negative",
    "Spiegami in tre frasi la differenza fra una chiave primaria e una chiave esterna in PostgreSQL.",
    "Conoscenza generale senza contesto personale.",
    "Risponde direttamente al quesito tecnico.",
  ),
  activation(
    "A12",
    "negative",
    "Traduci in inglese soltanto questa frase: Il progetto Iris parte domani.",
    "Il nome di un progetto in un testo da tradurre non richiede memoria personale.",
    "Traduce solo il testo fornito.",
  ),
  activation(
    "A13",
    "negative",
    "Correggi questo CSS e restituisci soltanto la regola: .card { display: flex; align-items: center center; }",
    "Correzione ordinaria autosufficiente senza nuovi fatti durevoli.",
    "Corregge align-items usando il solo frammento fornito.",
  ),
  activation(
    "A14",
    "negative",
    "Quanto fa il 18% di 250?",
    "Calcolo autosufficiente.",
    "Risponde 45.",
  ),
  activation(
    "A15",
    "negative",
    "Inventa due nomi per un progetto interamente immaginario di una biblioteca spaziale. Non riguarda nessuno dei miei progetti.",
    "Entità esplicitamente fittizie non sono conoscenza sull'utente.",
    "Propone due nomi senza cercare contesto personale.",
  ),
  activation(
    "A16",
    "negative",
    "Correggi solo la grammatica di questa email, senza aggiungere contenuti: Buongiorno Studio Selva, vi invio i documenti che mi avete chiesto ieri.",
    "Editing circoscritto di testo completo, anche se contiene il nome di un cliente.",
    "Mantiene il contenuto del testo dato e non aggiunge contesto recuperato.",
  ),
  activation(
    "A17",
    "negative",
    "Per un esempio didattico generico, quali sono due vantaggi dell'hosting gestito? Non sto scegliendo una soluzione per un progetto reale.",
    "Analisi generica e ipotetica, senza scelta adottata o ambito personale.",
    "Elenca due vantaggi generali senza collegarli a Portale Iris.",
  ),
  activation(
    "A18",
    "negative",
    "Sto sviluppando l'app Agent Brain. Spiega l'errore in questa funzione TypeScript: function count(xs: string[]): number { return xs.lenght; }. Usa il solo frammento.",
    "Sviluppare il prodotto Agent Brain non richiede la skill di memoria.",
    "Individua il refuso lenght/length, senza usare la memoria personale.",
  ),
  activation(
    "A19",
    "negative",
    "Non usare Brain né altre memorie o strumenti. Rispondi solo con i dati qui sotto: Portale Iris ha due attività aperte e ne chiudiamo una. Quante restano?",
    "Il divieto esplicito prevale sulla presenza di un nome noto.",
    "Risponde una senza caricare skill o usare strumenti.",
  ),
  activation(
    "A20",
    "negative",
    "Riassumi in una frase questa citazione da un articolo, che non rappresenta una mia decisione: Ogni team dovrebbe adottare solo database relazionali perché sono semplici da interrogare.",
    "Tesi attribuita a una fonte esterna in una sintesi circoscritta, non nuova conoscenza personale da salvare.",
    "Riassume attribuendo la tesi alla citazione, senza trasformarla in scelta dell'utente.",
  ),
];

const save = activationScenarios.find((c) => c.id === "A09");
if (!save) throw new Error("Missing authorized-save control");
save.expected.newDecisions = 1;
save.expected.noMutations = false;
save.expected.links = [
  { from: "new-decision", type: "decided_in", targetId: project.id },
];
save.expected.content = save.expected.content.slice(0, 1);
