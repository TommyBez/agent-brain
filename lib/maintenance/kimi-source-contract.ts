import type { ConsolidationCriterion } from "./consolidation-rubric";
import { GatewayRequestError } from "./gateway";
import type { ConsolidationEvaluationInput } from "./jev";
import { evaluateWithKimi, type KimiEvaluation } from "./kimi-evaluator";

export const KIMI_SOURCE_CONTRACT_ARMS = ["baseline", "clarified"] as const;
export type KimiSourceContractArm = (typeof KIMI_SOURCE_CONTRACT_ARMS)[number];

/** Frozen experimental clarification; no case-specific examples or labels. */
export const KIMI_SOURCE_CONTRACT_CLARIFICATION = [
  "Precisazione applicabile esclusivamente al criterio supported_by_evidence:",
  "Valuta se ogni affermazione fattuale aggiunta o corretta dalla modifica è giustificata da before o dalle evidenze fornite. Non devi stabilire la verità nel mondo esterno: non cercare informazioni esterne e non richiedere nuove prove per affermazioni rimaste invariate.",
  "Assegna fail se anche una sola aggiunta o correzione fattuale non è sostenuta dalle fonti fornite, è contraddetta, aggiunge una data o un'attribuzione non documentata, oppure esprime maggiore certezza della fonte. L'affermazione potrebbe essere vera nella realtà: questo non la rende supportata e non giustifica uncertain. Non serve dimostrarla falsa.",
  "Assegna pass quando tutte le aggiunte o correzioni fattuali sono sostenute dai passaggi forniti, comprese le parafrasi fedeli e le conseguenze direttamente implicate, senza introdurre fatti o assunzioni ulteriori. Non richiedere una citazione testuale identica. La sola rimozione di un duplicato, senza nuove affermazioni, non introduce un difetto di supporto.",
  "Riserva uncertain a un'ambiguità effettiva nell'interpretazione delle evidenze che impedisce di decidere se sostengano l'affermazione modificata. La semplice assenza di supporto per un'informazione aggiunta richiede fail, non uncertain.",
  "Nella rationale identifica l'affermazione modificata e il passaggio che la sostiene, la contraddice o rimane ambiguo; se manca il supporto, specifica quale informazione la modifica aggiunge senza documentarla. Non includere il ragionamento interno.",
  "Questa precisazione non modifica gli altri criteri, i criteri selezionati o lo schema JSON della risposta.",
].join("\n\n");

type KimiOptions = NonNullable<Parameters<typeof evaluateWithKimi>[2]>;

/**
 * Isolated experiment: keep the existing adapter, settings and response parser.
 * Baseline and selections without source support use the adapter unmodified.
 */
export async function evaluateWithKimiSourceContract(
  input: ConsolidationEvaluationInput,
  criteria: ConsolidationCriterion[],
  arm: KimiSourceContractArm,
  options: KimiOptions = {},
): Promise<KimiEvaluation> {
  if (!KIMI_SOURCE_CONTRACT_ARMS.includes(arm)) {
    throw new GatewayRequestError("Kimi source contract arm is invalid.", {
      retryable: false,
    });
  }
  if (
    arm === "baseline" ||
    !Array.isArray(criteria) ||
    !criteria.includes("supported_by_evidence")
  ) {
    return evaluateWithKimi(input, criteria, options);
  }

  const send = options.fetch ?? fetch;
  return evaluateWithKimi(input, criteria, {
    ...options,
    fetch: async (url, init) => {
      // This body is created by evaluateWithKimi, not caller/provider data.
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      const system = body.messages[0];
      if (system?.role !== "system" || typeof system.content !== "string") {
        throw new Error("Kimi system prompt is unavailable.");
      }
      system.content += `\n\n${KIMI_SOURCE_CONTRACT_CLARIFICATION}`;
      return send(url, { ...init, body: JSON.stringify(body) });
    },
  });
}
