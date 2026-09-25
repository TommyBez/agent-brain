import {
  type SourceAuditContext,
  type SourceAuditErrorReason,
  SourceAuditValidationError,
} from "./kimi-source-audit";

export const KIMI_SOURCE_CHALLENGE_CONTRACT = {
  version: "source-counterexample-v4-single-review",
  instructions: [
    "Queste istruzioni riguardano soltanto supported_by_evidence. Esegui un controllo di implicazione delle affermazioni e associazioni introdotte dal testo: cerca un controesempio compatibile con le fonti. Non conosci giudizi di altri valutatori e non devi presumerne l'esistenza. Gli eventuali altri criteri selezionati hanno giudizi separati nella stessa risposta, secondo la loro rubrica.",
    "Per ogni sourceAudit.units restituisci associations. unitId identifica già il testo completo: non ricopiarlo nella risposta. Esamina le NUOVE associazioni fatto/data/fonte/ambito, non riesaminare separatamente ogni dettaglio ereditato e invariato. Espandi soltanto le distribuzioni introdotte o modificate ('ogni', 'ciascuno', elenchi, intervalli) in una riga per ciascuna data e fonte coinvolta. date è una sola data pertinente; dateRole specifica se data un evento, una dichiarazione, un'osservazione o una decorrenza. source è una singola fonte/autore; sourceRole specifica se ha dichiarato, osservato, documentato o è stata consultata. Le dimensioni assenti hanno stringa vuota. Se un'unità non introduce alcuna associazione fattuale, restituisci una sola riga not_applicable.",
    "Ogni nuova affermazione fattuale va verificata anche quando non contiene date, fonti nominate o quantificatori: fact identifica l'affermazione e le dimensioni assenti restano vuote. Non usare not_applicable solo perché mancano una data o un'attribuzione. La rimozione di un duplicato senza nuove affermazioni non introduce un difetto di supporto; non richiedere prove esterne per fatti invariati.",
    "Se un'unità ha contextChange, le sue parole possono essere invariate ma una nuova intestazione o introduzione può modificarne data, fonte o ambito. Verifica queste nuove associazioni confrontando il contesto prima/dopo. Un titolo fattuale o distributivo modifica anche le affermazioni sottostanti: non trattarlo come semplice formattazione né ignorare le unità di testo ereditato segnalate da contextChange.",
    "Mantieni la risposta compatta: fact identifica la singola relazione in poche parole; source e date sono valori brevi, non copie di frasi. evidence contiene citazioni brevi ma sufficienti a controllare il collegamento, senza copiare intere pagine. alternative indica soltanto la lettura alternativa pertinente a quella relazione; non ripete tutto after né tutta la storia del documento.",
    "Ogni evidence.quote è un UNICO segmento contiguo copiato esattamente dalla fonte indicata. Non inserire ellissi, puntini, congiunzioni, spazi o punteggiatura per collegare parti distanti. Per due passaggi separati usa due elementi evidence distinti, ciascuno con citazione letterale contigua. Il codice respinge citazioni abbreviate o ricomposte.",
    "Per ogni associazione cerca una lettura delle fonti nella quale la relazione aggiunta non sussiste, senza negare alcuna affermazione documentata. Se una lettura del genere esiste, la relazione non è implicata: status unsupported, alternative descrive il controesempio e evidence cita i passaggi compatibili con esso. Non serve dimostrare falsa la relazione nel mondo esterno. Se il significato dei passaggi è realmente indecidibile fra più interpretazioni usa ambiguous, sempre spiegando alternative. Se invece le fonti obbligano quella relazione, status entailed e alternative vuota. I fatti ereditati restano utilizzabili da before senza verificarli nel mondo esterno; testo non fattuale usa not_applicable.",
    "Distingui precisamente una fonte che riporta un'osservazione da una fonte effettivamente consultata in un'altra osservazione. Due documenti che riportano lo stesso stato non provano che l'uno sia stato consultato dall'altro. Un riepilogo cumulativo di una situazione persistente implica soltanto la persistenza di quella situazione; non assegna automaticamente tutti i dettagli presenti nell'ultima osservazione a ciascuna delle precedenti. Ricostruisci le associazioni dalle prove individuali, senza assumere invarianti che i passaggi non dichiarano.",
    "Una data, un nome o un termine presente in un passo diverso non è una prova della relazione. evidence usa soltanto sourcePaths e citazioni letterali; cita il contesto sufficiente a identificare la singola associazione. Il testo dell'operazione e after non sono prove. Non risolvere la verifica sostituendo l'affermazione precisa con una versione più debole. Se lo stato di proprietà è documentato ma la data di acquisizione no, l'associazione all'evento resta priva di prova.",
    "Il codice ricaverà il verdetto dalle associazioni: almeno un unsupported implica fail; altrimenti almeno un ambiguous implica uncertain; altrimenti pass. Non restituire un verdetto globale o ragionamento interno. Rationale riassume il riscontro in massimo 500 caratteri.",
  ].join("\n\n"),
} as const;

/** Local response validation only; never included in model instructions or schema. */
export const KIMI_SOURCE_CHALLENGE_VALIDATION_VERSION =
  "source-challenge-validation-v2-date-role-annotation";

type Association = {
  fact: string;
  date: string;
  dateRole: string;
  source: string;
  sourceRole: string;
  quantifier: string;
  evidence: { source: string; quote: string }[];
  status: "entailed" | "unsupported" | "ambiguous" | "not_applicable";
  alternative: string;
};
export type KimiSourceChallenge = {
  unitId: string;
  associations: Association[];
}[];

export function sourceChallengeSchema(context: SourceAuditContext) {
  const string = { type: "string" };
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["unitId", "associations"],
      properties: {
        unitId: context.units.length
          ? { type: "string", enum: context.units.map(({ id }) => id) }
          : string,
        associations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "fact",
              "date",
              "dateRole",
              "source",
              "sourceRole",
              "quantifier",
              "evidence",
              "status",
              "alternative",
            ],
            properties: {
              fact: string,
              date: string,
              dateRole: string,
              source: string,
              sourceRole: string,
              quantifier: string,
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["source", "quote"],
                  properties: {
                    source: Object.keys(context.sources).length
                      ? { type: "string", enum: Object.keys(context.sources) }
                      : string,
                    quote: string,
                  },
                },
              },
              status: {
                type: "string",
                enum: [
                  "entailed",
                  "unsupported",
                  "ambiguous",
                  "not_applicable",
                ],
              },
              alternative: string,
            },
          },
        },
      },
    },
  };
}

/** Existence/consistency checks, not an independent semantic oracle. */
export function validateSourceChallenge(
  raw: unknown,
  context: SourceAuditContext,
): {
  verdict: "pass" | "fail" | "uncertain";
  associations: KimiSourceChallenge;
} {
  const fail = (reason: SourceAuditErrorReason): never => {
    throw new SourceAuditValidationError(reason);
  };
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const exact = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  if (!Array.isArray(raw) || raw.length !== context.units.length)
    return fail("source_challenge_coverage");
  const seen = new Set<string>();
  const statuses: Association["status"][] = [];
  for (const item of raw) {
    const unit = record(item);
    if (
      !unit ||
      !exact(unit, ["unitId", "associations"]) ||
      typeof unit.unitId !== "string"
    )
      return fail("source_challenge_unit");
    const target = context.units.find(({ id }) => id === unit.unitId);
    if (!target) return fail("source_challenge_unit");
    if (seen.has(target.id)) return fail("source_challenge_duplicate_unit");
    seen.add(target.id);
    if (
      !Array.isArray(unit.associations) ||
      !unit.associations.length ||
      unit.associations.length > 60
    )
      return fail("source_challenge_associations");
    for (const value of unit.associations) {
      const row = record(value);
      const texts = [
        "fact",
        "date",
        "dateRole",
        "source",
        "sourceRole",
        "quantifier",
        "alternative",
      ];
      if (
        !row ||
        !exact(row, [...texts, "evidence", "status"]) ||
        texts.some(
          (key) =>
            typeof row[key] !== "string" || (row[key] as string).length > 1500,
        )
      )
        return fail("source_challenge_fields");
      if (
        !["entailed", "unsupported", "ambiguous", "not_applicable"].includes(
          String(row.status),
        )
      )
        return fail("source_challenge_status");
      if (!Array.isArray(row.evidence) || row.evidence.length > 20)
        return fail("source_challenge_evidence");
      for (const value of row.evidence) {
        const citation = record(value);
        if (
          !citation ||
          !exact(citation, ["source", "quote"]) ||
          typeof citation.source !== "string" ||
          typeof citation.quote !== "string" ||
          !citation.quote.trim() ||
          citation.quote.length > 12_000 ||
          !Object.hasOwn(context.sources, citation.source)
        )
          return fail("source_challenge_citation");
        if (!context.sources[citation.source].includes(citation.quote))
          return fail("source_challenge_literal_quote");
      }
      const alternative = (row.alternative as string).trim();
      if (row.status === "entailed" && (!row.evidence.length || alternative))
        return fail("source_challenge_entailed_consistency");
      if (
        (row.status === "unsupported" || row.status === "ambiguous") &&
        !alternative
      )
        return fail("source_challenge_counterexample_required");
      if (row.status !== "not_applicable" && !(row.fact as string).trim())
        return fail("source_challenge_fact_required");
      // A role annotates a supplied date; without a date it has no chronological
      // meaning. Retain the raw annotation, but never invent a date from it.
      if (
        Boolean((row.date as string).trim()) &&
        !Boolean((row.dateRole as string).trim())
      )
        return fail("source_challenge_date_role");
      if (
        Boolean((row.source as string).trim()) !==
        Boolean((row.sourceRole as string).trim())
      )
        return fail("source_challenge_source_role");
      statuses.push(row.status as Association["status"]);
    }
  }
  const verdict = statuses.includes("unsupported")
    ? "fail"
    : statuses.includes("ambiguous")
      ? "uncertain"
      : "pass";
  return { verdict, associations: raw as KimiSourceChallenge };
}
