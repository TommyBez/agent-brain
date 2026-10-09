import assert from "node:assert/strict";
import { writeSchema } from "../../lib/brain/schemas";
import type { LinkType } from "../../lib/brain/types";
import type { Page } from "./brain";

export type Scenario = {
  id: string;
  group: "development" | "holdout";
  request: string;
  initial: Page[];
  activation?: {
    shouldActivate: boolean;
    category: "explicit" | "retrieval" | "memory" | "negative";
    rationale: string;
  };
  expected: {
    newDecisions: number;
    updatedIds: string[];
    noMutations: boolean;
    links: {
      type: LinkType;
      targetId: string;
      from: "new-decision" | string;
    }[];
    content: string[];
  };
};

const projectId = "00000000-0000-4000-8000-000000000001";
const decisionId = "00000000-0000-4000-8000-000000000002";
const companyId = "00000000-0000-4000-8000-000000000003";
function page(
  id: string,
  title: string,
  type: Page["type"],
  markdown: string,
  slug: string,
): Page {
  return {
    ...writeSchema.parse({
      title,
      type,
      markdown,
      expectedVersion: 0,
      aliases: [title],
      tags: ["fixture"],
      source: "Synthetic fixture",
    }),
    id,
    slug,
    version: 1,
  };
}
const project = page(
  projectId,
  "Portale Iris",
  "project",
  "# Portale Iris\n\nPortale clienti di Studio Selva. Responsabile: Marta. Il portale deve supportare l'italiano. L'approccio di hosting non è ancora stato scelto.",
  "project/iris",
);
const company = page(
  companyId,
  "Studio Selva",
  "company",
  "# Studio Selva\n\nAzienda del proprietario. Gestisce tre prodotti, fra cui Portale Iris.",
  "company/selva",
);
const decision = page(
  decisionId,
  "Hosting gestito per Iris",
  "decision",
  "# Hosting gestito per Iris\n\nIl 1 ottobre 2026 il proprietario ha scelto hosting gestito per Iris perché il team non può coprire le operazioni. Accetta un costo ricorrente maggiore. L'implementazione non è ancora iniziata.",
  "decision/hosting-iris",
);
decision.links = [{ targetRef: projectId, type: "decided_in", label: "" }];
const decidedProject = {
  ...project,
  markdown:
    "# Portale Iris\n\nPortale clienti di Studio Selva. Responsabile: Marta. Il portale deve supportare l'italiano. Dal 1 ottobre 2026 è stato scelto hosting gestito; l'implementazione non è iniziata.",
};
const save =
  "Oggi è l'8 ottobre 2026. Salva nel Brain le informazioni utili di questo aggiornamento, preservando ciò che è già noto.\n\n";

function scenario(
  id: string,
  request: string,
  newDecisions: number,
  content: string[],
  options: Partial<Scenario["expected"]> & {
    initial?: Page[];
    group?: Scenario["group"];
    raw?: boolean;
  } = {},
): Scenario {
  return {
    id,
    group: options.group ?? "development",
    request: options.raw ? request : save + request,
    initial: structuredClone(options.initial ?? [project]),
    expected: {
      newDecisions,
      updatedIds: options.updatedIds ?? [],
      noMutations: options.noMutations ?? false,
      links:
        options.links ??
        (newDecisions
          ? [{ type: "decided_in", targetId: projectId, from: "new-decision" }]
          : []),
      content,
    },
  };
}

/** Fixed before inference. Expectations never enter a trial's prompt or Brain state. */
export const scenarios: Scenario[] = [
  scenario(
    "D01",
    "Per Iris ho scelto hosting gestito: non abbiamo persone per coprire le operazioni. Accetto un costo ricorrente maggiore. Non abbiamo ancora implementato nulla.",
    1,
    [
      "La decisione registra hosting gestito, motivazione operativa e costo accettato.",
      "Il progetto riflette la scelta senza dichiararla implementata e conserva Marta e il requisito italiano.",
    ],
  ),
  scenario(
    "D02",
    "Confermo che Iris servirà solo studi professionali. Escludiamo le catene di negozi dalla prima versione.",
    1,
    [
      "La decisione registra destinatari ed esclusione limitata alla prima versione; non esclusione perpetua.",
    ],
  ),
  scenario(
    "D03",
    "Per Iris useremo PostgreSQL come database principale. È deciso.",
    1,
    [
      "La decisione registra PostgreSQL come database principale, senza inventare motivazioni, alternative o migrazioni completate.",
    ],
  ),
  scenario(
    "D04",
    "Per Iris facciamo prima l'esportazione dei documenti; la dashboard viene dopo. Ho scelto quest'ordine perché i clienti devono migrare i dati prima di usarla.",
    1,
    [
      "La decisione conserva ordine delle fasi e motivazione, senza cancellare definitivamente la dashboard.",
    ],
  ),
  scenario(
    "D05",
    "Da oggi ho stabilito che Studio Selva richiederà una revisione umana prima di pubblicare contenuti generati con AI. Vale per tutti e tre i prodotti.",
    1,
    [
      "La decisione riguarda tutta Studio Selva, non solo Iris; richiede revisione prima della pubblicazione.",
    ],
    {
      initial: [company, project],
      links: [
        { type: "relates_to", targetId: companyId, from: "new-decision" },
      ],
    },
  ),
  scenario(
    "D06",
    "Approvo una prova di due settimane di hosting gestito per lo staging di Iris. Poi confronteremo i risultati; per la produzione non abbiamo ancora scelto.",
    1,
    [
      "La decisione approva solo la prova di due settimane nello staging; la produzione resta senza scelta.",
    ],
  ),
  scenario(
    "D07",
    "Per Iris rinunciamo alla ricerca semantica nella prima versione: voglio prima verificare se la ricerca testuale basta. Questa è la direzione approvata.",
    1,
    [
      "La scelta esclude la ricerca semantica solo dalla prima versione, con la motivazione dichiarata.",
    ],
  ),
  scenario(
    "D08",
    "Per Iris confermo la vendita con abbonamento annuale, senza piano gratuito. Il servizio include l'assistenza e non voglio sostenerla per account non paganti.",
    1,
    [
      "La scelta commerciale riguarda abbonamento annuale e assenza di piano gratuito, con la ragione dell'assistenza.",
    ],
    { group: "holdout" },
  ),
  scenario(
    "D09",
    "Aggiungi alla scelta dell'hosting gestito di Iris questo motivo: il fornitore garantisce reperibilità anche nel weekend. La scelta resta la stessa, non è una nuova decisione.",
    0,
    [
      "La decisione esistente include la reperibilità nel weekend e conserva motivazione e costo già noti; nessuna decisione duplicata.",
    ],
    { initial: [decidedProject, decision], updatedIds: [decisionId] },
  ),
  scenario(
    "D10",
    "Per Iris sostituisco la scelta del 1 ottobre: useremo self-hosting. Ora abbiamo assunto due persone per le operazioni. La nuova scelta vale da oggi, ma il passaggio non è ancora implementato.",
    1,
    [
      "La nuova decisione sostituisce hosting gestito con self-hosting dall'8 ottobre per l'assunzione di due persone.",
      "La decisione precedente resta conservata con la sua motivazione e viene indicata come superata; il progetto riflette la nuova direzione senza dichiarare la migrazione completata.",
    ],
    {
      initial: [decidedProject, decision],
      links: [
        { type: "decided_in", targetId: projectId, from: "new-decision" },
        { type: "supersedes", targetId: decisionId, from: "new-decision" },
      ],
    },
  ),
  scenario(
    "N11",
    "Per Iris stiamo confrontando hosting gestito e self-hosting. Non ho ancora scelto: uno riduce il lavoro operativo, l'altro offre più controllo.",
    0,
    [
      "L'eventuale confronto salvato resta aperto; nessuna opzione è descritta come scelta adottata.",
    ],
  ),
  scenario(
    "N12",
    "L'agente mi ha consigliato PostgreSQL per Iris, ma non ho ancora accettato la raccomandazione.",
    0,
    [
      "Una raccomandazione dell'agente non diventa una decisione del proprietario.",
    ],
  ),
  scenario(
    "N13",
    "Ho corretto il disallineamento dell'icona nella barra di Iris e verificato il risultato in locale.",
    0,
    [
      "Nessuna decisione autonoma per il bug fix; un eventuale aggiornamento distingue verifica locale da rilascio.",
    ],
  ),
  scenario(
    "N14",
    "Confermo esattamente quanto già registrato per Iris: hosting gestito perché non copriamo le operazioni, accettando il costo maggiore. Non ci sono novità.",
    0,
    ["Nessuna scrittura: scelta, motivazione e costo sono già registrati."],
    { initial: [decidedProject, decision], noMutations: true },
  ),
  scenario(
    "N15",
    "Ho letto un articolo che sostiene che l'hosting gestito sia preferibile per piccoli team. Non ho valutato se il consiglio si applichi a Iris e non ho scelto nulla.",
    0,
    [
      "Il parere della fonte non viene trasformato in una scelta per Iris, né vengono inventati autore o URL.",
    ],
  ),
  scenario(
    "N16",
    "Per Iris l'esportazione CSV è implementata e verificata solo in staging. La produzione non è stata testata.",
    0,
    [
      "L'eventuale stato salvato conserva il confine staging/produzione e non genera una scelta autonoma.",
    ],
    { group: "holdout" },
  ),
  scenario(
    "N17",
    "Per Iris ho scelto PostgreSQL. Per ora limitati a rispondermi, non salvare nulla nel Brain.",
    0,
    ["Il divieto esplicito di salvataggio è rispettato."],
    { noMutations: true, raw: true, group: "holdout" },
  ),
  scenario(
    "N18",
    "Quale hosting avevamo scelto per Iris e perché? Recupera il contesto, senza aggiornare il Brain.",
    0,
    [
      "La risposta recupera hosting gestito, motivazione operativa e costo accettato dalle pagine, senza scritture.",
    ],
    {
      initial: [decidedProject, decision],
      noMutations: true,
      raw: true,
      group: "holdout",
    },
  ),
  scenario(
    "N19",
    "Per controllare la formattazione di Iris ho usato oggi un comando alternativo perché quello solito non partiva. Non è una nuova convenzione del progetto.",
    0,
    [
      "La scelta occasionale di un comando non diventa una regola operativa persistente.",
    ],
    { group: "holdout" },
  ),
  scenario(
    "N20",
    "Se Iris supererà mille clienti potremmo valutare un'infrastruttura dedicata. È solo un'ipotesi, non un impegno né una decisione.",
    0,
    [
      "L'ipotesi condizionale resta tale; non vengono inventati impegni o una decisione adottata.",
    ],
    { group: "holdout" },
  ),
];

export function validateDataset(cases: Scenario[]) {
  assert(cases.length > 0, "Empty dataset");
  assert.equal(
    new Set(cases.map((c) => c.id)).size,
    cases.length,
    "Duplicate case IDs",
  );
  for (const c of cases) {
    assert.match(c.id, /^[DNA]\d{2}$/);
    if (c.id.startsWith("A")) {
      assert(c.activation, "Activation expectation missing");
      assert.equal(typeof c.activation.shouldActivate, "boolean");
      assert(c.activation.rationale.trim());
      assert.equal(
        c.activation.shouldActivate,
        c.activation.category !== "negative",
      );
    } else assert(!c.activation, "Unexpected activation expectation");
    assert(c.request && c.expected.content.length);
    assert(
      Number.isInteger(c.expected.newDecisions) && c.expected.newDecisions >= 0,
    );
    const ids = new Set(c.initial.map((p) => p.id));
    assert.equal(ids.size, c.initial.length);
    for (const p of c.initial) {
      const { version, ...payload } = p;
      writeSchema.parse({ ...payload, expectedVersion: version });
      for (const link of p.links)
        assert(ids.has(link.targetRef), "Unresolved fixture link");
    }
    for (const id of c.expected.updatedIds) assert(ids.has(id));
    for (const link of c.expected.links) assert(ids.has(link.targetId));
    if (c.expected.noMutations)
      assert(
        c.expected.newDecisions === 0 &&
          !c.expected.updatedIds.length &&
          !c.expected.links.length,
      );
  }
}
