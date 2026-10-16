import { fingerprint } from "../../canonical-json";
import { type GatewayCall, gatewayRequest } from "../gateway";
import { evaluateJev, JEV_MODEL } from "./jev";
import { resolvePromptProfile } from "./prompts";
import { preparationQuestions, screeningQuestions } from "./questions";
import { type EvaluationRequest, POLICY } from "./types";

export function jevRuntimeProfile() {
  const profile = resolvePromptProfile();
  return {
    profileId: profile.id,
    profileHash: fingerprint(profile.prompts),
    policyVersion: POLICY.version,
    model: JEV_MODEL,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };
}

/** Fixed Italian evidence only: diagnostics never read or modify Brain pages. */
export function jevDiagnosticRequests(): Record<string, EvaluationRequest> {
  const fact = "Il laboratorio Ginestra apre il martedì dalle 9 alle 12.";
  const page = {
    id: "ginestra",
    title: "Laboratorio Ginestra",
    type: "organization",
    markdown: `${fact}\n\n${fact}\n\nHo completato il riordino della scheda.`,
    links: [],
  };
  const person = {
    id: "marta",
    title: "Marta Riva",
    type: "person",
    markdown: "Marta Riva lavora al laboratorio Ginestra come responsabile.",
    links: [],
  };
  const target = [
    { id: "passaggio-a", pageId: page.id, text: fact },
    { id: "passaggio-b", pageId: page.id, text: fact },
  ];
  return {
    pagina: { state: { pages: [page] }, questions: screeningQuestions(false) },
    collegamenti: {
      state: { pages: [person, page] },
      questions: screeningQuestions(true),
    },
    consolidamento: {
      state: { pages: [page], target },
      questions: preparationQuestions("duplicate"),
    },
    conflitto: {
      state: {
        pages: [
          {
            ...page,
            markdown: `${fact}\n\nUn secondo appunto riporta che il laboratorio apre il giovedì. Nessuna fonte stabilisce quale orario sia valido.`,
          },
        ],
        target: [
          target[0],
          { ...target[1], text: "Il laboratorio Ginestra apre il giovedì." },
        ],
      },
      questions: preparationQuestions("conflict"),
    },
  };
}

export async function checkJevRuntime(send: GatewayCall = gatewayRequest) {
  const profile = jevRuntimeProfile();
  const checks = [];
  for (const [id, request] of Object.entries(jevDiagnosticRequests())) {
    const result = await evaluateJev(request, send);
    checks.push({
      id,
      requestHash: fingerprint(request),
      questionHashes: Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => [
          key,
          fingerprint(question),
        ]),
      ),
      model: result.model,
      answers: result.answers,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  }
  return { ...profile, checkedAt: new Date().toISOString(), checks };
}
