import { markdownDestinations } from "./consolidation-links";
import type { ConsolidationEvaluationInput } from "./jev";

export const KIMI_SOURCE_AUDIT_VERSION = "source-tuples-v4-contiguous";

export const KIMI_PRESERVATION_INSTRUCTIONS = [
  "Per preserves_distinct_information distingui il materiale consultabile per valutare (evidence) dal contenuto che il lettore potrà raggiungere dopo la scrittura (after e fonti collegate da after). La presenza di una fonte in evidence, la sua citazione in before o un vecchio snapshot della pagina non dimostrano che la fonte rimanga raggiungibile dal documento finale.",
  "preservationLinks è il riscontro deterministico delle destinazioni Markdown prima/dopo. Se removed contiene una destinazione, il collegamento preesistente è stato rimosso: assegna fail a preserves_distinct_information, anche quando la fonte è ancora fornita in evidence e il fatto principale è riportato in after. Una citazione senza il precedente link non preserva lo stesso accesso alla fonte. Non richiedere nuovi link che non esistevano in before; rimuovere copie duplicate dello stesso link è consentito se almeno una copia della destinazione sopravvive. Un elenco removed vuoto non prova da solo la conservazione di fatti, qualificazioni, date o attribuzioni: valuta anche queste dimensioni.",
].join("\n\n");

export const KIMI_SOURCE_AUDIT_INSTRUCTIONS = [
  "Per supported_by_evidence compila PRIMA audit e soltanto dopo verdict e rationale. sourceAudit.units è la copertura del testo aggiunto o modificato calcolata dal codice; restituisci esattamente una voce per ogni unità, anche per titoli o testo non fattuale. Non rivalutare la verità di affermazioni invariate.",
  "Se un'unità ha contextChange, le parole possono essere invariate ma la nuova intestazione o frase introduttiva può cambiarne data, attribuzione o ambito. Verifica queste nuove associazioni rispetto al contesto precedente, senza richiedere nuove prove per il fatto ereditato. Un titolo fattuale o distributivo non è semplice formattazione: il suo effetto sulle frasi sottostanti fa parte dell'affermazione modificata.",
  "Scomponi ogni unità in affermazioni atomiche: afterQuote deve essere il testo COMPLETO dell'unità scelto tra le opzioni dello schema, ripetuto se contiene più affermazioni. fact descrive il singolo fatto/evento esaminato; temporal la data E il ruolo che svolge (dichiarazione, osservazione, evento, decorrenza); attribution chi afferma cosa e da quale fonte; quantifier l'ambito (ciascuno, tutti, sempre, solo, intervallo). Una dimensione esaminata deve avere una descrizione concreta. Per una dimensione assente usa not_applicable come check; la descrizione può essere vuota, not_applicable oppure spiegare perché non si applica. Una frase non fattuale ha tutti i check not_applicable.",
  "Per ogni affermazione cita evidence con source uguale a un percorso di sourceAudit.sourcePaths e quote letterale non vuota del testo in quel percorso. Sono ammesse soltanto before ed evidence: after e la motivazione dell'operazione non provano nulla. Le citazioni devono contenere il contesto necessario a collegare fatto, data, autore/fonte e quantificatore; una parola o data presente altrove non sostiene quel collegamento.",
  "Ogni quote è un UNICO segmento contiguo copiato esattamente dalla fonte indicata. Non inserire ellissi, puntini, congiunzioni, spazi o punteggiatura per unire pezzi distanti. Se la prova richiede due passaggi separati, restituisci due elementi evidence distinti, ciascuno con la propria citazione letterale contigua. Il codice respinge citazioni abbreviate o ricomposte.",
  "checks valuta separatamente fact, temporal, attribution e quantifier: supported, unsupported, ambiguous o not_applicable. Una citazione esistente NON dimostra che implichi l'affermazione. Una fonte che attesta uno stato a una certa data non documenta automaticamente che il corrispondente evento sia avvenuto in quella data. Una raccolta di osservazioni con date/fonti diverse non documenta automaticamente tutti i dettagli a ciascuna data o da ciascuna fonte: verifica separatamente ogni associazione distribuita da 'ogni', 'ciascuno', 'tutti' e simili. Non sostituire il dettaglio controverso con una parafrasi più debole durante la verifica.",
  "L'assenza di supporto per un'aggiunta è unsupported, anche se plausibile o non contraddetta. ambiguous è riservato a due letture realmente compatibili con i passaggi disponibili, non a una prova mancante. Le informazioni ereditate rimaste identiche possono usare direttamente before, senza richiedere una prova esterna.",
  "Il verdetto è obbligatoriamente fail se almeno un check è unsupported; altrimenti uncertain se almeno un check è ambiguous; altrimenti pass. Spiega sinteticamente ogni riscontro in finding, citando il rapporto documentato o mancante; non restituire ragionamento interno. Rationale è soltanto una sintesi di massimo 500 caratteri: le prove sono già nell'audit, non ripeterle tutte. Il codice verifica citazioni, copertura e coerenza del verdetto, non presume che il mero riscontro testuale sia entailment semantico.",
].join("\n\n");

export const KIMI_SOURCE_AUDIT_CONTRACT = {
  version: KIMI_SOURCE_AUDIT_VERSION,
  instructions: KIMI_SOURCE_AUDIT_INSTRUCTIONS,
  preservationInstructions: KIMI_PRESERVATION_INSTRUCTIONS,
} as const;

const DIMENSIONS = ["fact", "temporal", "attribution", "quantifier"] as const;
type Dimension = (typeof DIMENSIONS)[number];
type Check = "supported" | "unsupported" | "ambiguous" | "not_applicable";
type Citation = { source: string; quote: string };
export type SourceClaim = Record<Dimension, string> & {
  afterQuote: string;
  evidence: Citation[];
  checks: Record<Dimension, Check>;
  finding: string;
};
export type KimiSourceAudit = { unitId: string; claims: SourceClaim[] }[];
export type SourceAuditContext = {
  units: {
    id: string;
    text: string;
    contextChange?: { before: string[][]; after: string[] };
  }[];
  sources: Record<string, string>;
};
export type SourceAuditErrorReason =
  | "invalid_source_audit"
  | "incomplete_source_audit"
  | "invalid_source_citation"
  | "invalid_source_challenge"
  | "inconsistent_source_verdict";

export type PreservationLinkAudit = {
  before: string[];
  after: string[];
  removed: string[];
};

export function preservationLinkAudit(
  input: ConsolidationEvaluationInput,
): PreservationLinkAudit {
  const before = [...markdownDestinations(documentText(input.before))].sort();
  const after = [...markdownDestinations(documentText(input.after))].sort();
  return {
    before,
    after,
    removed: before.filter((destination) => !after.includes(destination)),
  };
}

export class SourceAuditValidationError extends Error {
  constructor(readonly reasonCode: SourceAuditErrorReason) {
    super("Kimi source audit is invalid.");
  }
}

function fail(reason: SourceAuditErrorReason): never {
  throw new SourceAuditValidationError(reason);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function text(value: unknown, limit: number, empty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= limit &&
    (empty || value.trim().length > 0)
  );
}

function documentText(value: unknown): string {
  if (typeof value === "string") return value;
  const doc = object(value);
  if (typeof doc?.markdown === "string") return doc.markdown;
  return JSON.stringify(value);
}

function collectSources(
  value: unknown,
  path: string,
  output: Record<string, string>,
) {
  if (typeof value === "string") {
    if (value.trim()) output[path] = value;
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectSources(item, `${path}/${index}`, output);
    });
  } else if (object(value)) {
    for (const [key, item] of Object.entries(value as object)) {
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      collectSources(item, `${path}/${escaped}`, output);
    }
  }
}

/** Exact paragraph diff: unchanged blocks need no new evidence. No model selects its own coverage. */
export function sourceAuditContext(
  input: ConsolidationEvaluationInput,
): SourceAuditContext {
  const blocks = (value: unknown) =>
    documentText(value)
      .split(/\r?\n\s*\r?\n/)
      .filter((part) => part.trim());
  const before = blocks(input.before);
  const after = blocks(input.after);
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }
  // Preserve unchanged blocks within a multi-block edit too. Their full context
  // stays in the request; the support audit is restricted to newly worded text.
  const unchanged = new Map<string, number>();
  for (const block of before.slice(start, beforeEnd))
    unchanged.set(block, (unchanged.get(block) ?? 0) + 1);
  const units: SourceAuditContext["units"] = [];
  for (const block of after.slice(start, afterEnd)) {
    const count = unchanged.get(block) ?? 0;
    if (count) unchanged.set(block, count - 1);
    else units.push({ id: `u${units.length + 1}`, text: block });
  }
  // An unchanged paragraph can acquire a new claim through a changed heading
  // or immediately preceding introduction. Compare textual contexts; do not
  // infer in code that the new association is semantically valid or invalid.
  const contexts = (parts: string[]) => {
    const headings: string[] = [];
    return parts.map((part, index) => {
      for (const match of part.matchAll(/^ {0,3}(#{1,6})\s+(.+)$/gm)) {
        headings.length = match[1].length - 1;
        headings[match[1].length - 1] = match[0];
      }
      return [
        ...headings.filter(Boolean),
        ...(index ? [parts[index - 1]] : []),
      ];
    });
  };
  const beforeContexts = contexts(before);
  const afterContexts = contexts(after);
  const texts = new Set(units.map((unit) => unit.text));
  for (let index = 0; index < after.length; index++) {
    if (texts.has(after[index])) continue;
    const previousContexts = before.flatMap((part, oldIndex) =>
      part === after[index] ? [beforeContexts[oldIndex]] : [],
    );
    if (
      previousContexts.length &&
      !previousContexts.some(
        (context) =>
          JSON.stringify(context) === JSON.stringify(afterContexts[index]),
      )
    ) {
      units.push({
        id: `u${units.length + 1}`,
        text: after[index],
        contextChange: {
          before: previousContexts,
          after: afterContexts[index],
        },
      });
    }
  }
  const sources: Record<string, string> = {};
  collectSources(input.before, "/before", sources);
  collectSources(input.evidence, "/evidence", sources);
  return { units, sources };
}

export function sourceAuditSchema(context: SourceAuditContext) {
  const string = { type: "string" };
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["unitId", "claims"],
      properties: {
        unitId: context.units.length
          ? { type: "string", enum: context.units.map(({ id }) => id) }
          : string,
        claims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "afterQuote",
              ...DIMENSIONS,
              "evidence",
              "checks",
              "finding",
            ],
            properties: {
              afterQuote: context.units.length
                ? {
                    type: "string",
                    enum: context.units.map(({ text }) => text),
                  }
                : string,
              ...Object.fromEntries(
                DIMENSIONS.map((dimension) => [dimension, string]),
              ),
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
              checks: {
                type: "object",
                additionalProperties: false,
                required: [...DIMENSIONS],
                properties: Object.fromEntries(
                  DIMENSIONS.map((dimension) => [
                    dimension,
                    {
                      type: "string",
                      enum: [
                        "supported",
                        "unsupported",
                        "ambiguous",
                        "not_applicable",
                      ],
                    },
                  ]),
                ),
              },
              finding: string,
            },
          },
        },
      },
    },
  };
}

/** Structural evidence checks only: semantic entailment remains the model's responsibility. */
export function validateSourceAudit(
  raw: unknown,
  verdict: "pass" | "fail" | "uncertain",
  context: SourceAuditContext,
): KimiSourceAudit {
  if (!Array.isArray(raw) || raw.length !== context.units.length)
    fail("incomplete_source_audit");
  const seen = new Set<string>();
  const statuses: Check[] = [];
  for (const entry of raw) {
    const unit = object(entry);
    if (
      !unit ||
      !hasKeys(unit, ["unitId", "claims"]) ||
      typeof unit.unitId !== "string"
    )
      fail("invalid_source_audit");
    const target = context.units.find(({ id }) => id === unit.unitId);
    if (!target || seen.has(target.id)) fail("incomplete_source_audit");
    seen.add(target.id);
    if (
      !Array.isArray(unit.claims) ||
      !unit.claims.length ||
      unit.claims.length > 40
    )
      fail("invalid_source_audit");
    const covered = new Uint8Array(target.text.length);
    for (const rawClaim of unit.claims) {
      const claim = object(rawClaim);
      if (
        !claim ||
        !hasKeys(claim, [
          "afterQuote",
          ...DIMENSIONS,
          "evidence",
          "checks",
          "finding",
        ])
      )
        fail("invalid_source_audit");
      if (
        !text(claim.afterQuote, 12_000) ||
        !text(claim.finding, 1000) ||
        !DIMENSIONS.every((dimension) => text(claim[dimension], 1000, true))
      )
        fail("invalid_source_audit");
      let offset = target.text.indexOf(claim.afterQuote);
      if (offset < 0) fail("invalid_source_citation");
      while (offset >= 0) {
        covered.fill(1, offset, offset + claim.afterQuote.length);
        offset = target.text.indexOf(claim.afterQuote, offset + 1);
      }
      const checks = object(claim.checks);
      if (!checks || !hasKeys(checks, DIMENSIONS)) fail("invalid_source_audit");
      for (const dimension of DIMENSIONS) {
        const check = checks[dimension];
        if (
          !["supported", "unsupported", "ambiguous", "not_applicable"].includes(
            String(check),
          )
        )
          fail("invalid_source_audit");
        if (
          check !== "not_applicable" &&
          ["", "not_applicable"].includes((claim[dimension] as string).trim())
        )
          fail("inconsistent_source_verdict");
        statuses.push(check as Check);
      }
      if (
        checks.fact === "not_applicable" &&
        DIMENSIONS.some((dimension) => checks[dimension] !== "not_applicable")
      )
        fail("inconsistent_source_verdict");
      if (!Array.isArray(claim.evidence) || claim.evidence.length > 20)
        fail("invalid_source_citation");
      if (
        DIMENSIONS.some((dimension) => checks[dimension] === "supported") &&
        !claim.evidence.length
      )
        fail("invalid_source_citation");
      for (const rawCitation of claim.evidence) {
        const citation = object(rawCitation);
        if (
          !citation ||
          !hasKeys(citation, ["source", "quote"]) ||
          !text(citation.source, 1000) ||
          !text(citation.quote, 12_000) ||
          !Object.hasOwn(context.sources, citation.source) ||
          !context.sources[citation.source].includes(citation.quote)
        )
          fail("invalid_source_citation");
      }
    }
    // Punctuation/Markdown delimiters may fall between quotes; factual words and
    // date digits must be covered. This is not a proof of atomic completeness.
    for (let i = 0; i < target.text.length; i++) {
      if (!covered[i] && /[\p{L}\p{N}]/u.test(target.text[i]))
        fail("incomplete_source_audit");
    }
  }
  const derived = statuses.includes("unsupported")
    ? "fail"
    : statuses.includes("ambiguous")
      ? "uncertain"
      : "pass";
  if (verdict !== derived) fail("inconsistent_source_verdict");
  return raw as KimiSourceAudit;
}
