import type { BrainPage } from "../../lib/brain/types";
import type {
  Answer,
  Evaluate,
  EvaluationRequest,
} from "../../lib/maintenance/consolidator/types";

export function page(id: string, markdown = `Fact about ${id}.`): BrainPage {
  return {
    id,
    slug: id,
    title: id,
    type: "note",
    markdown,
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-30",
    updatedAt: "2026-09-30",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}
export function evaluator(
  choose: (id: string, request: EvaluationRequest) => number | string = () => 0,
  requests: EvaluationRequest[] = [],
): Evaluate {
  return async (request) => {
    requests.push(request);
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const value = choose(id, request);
      if (question.type === "boolean")
        answers[id] = {
          type: "boolean",
          probability: typeof value === "number" ? value : 0,
        };
      else {
        const choice = typeof value === "string" ? value : "none";
        answers[id] = {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [
              key,
              key === choice ? 1 : 0,
            ]),
          ),
        };
      }
    }
    return { model: "test", answers, inputTokens: 100, outputTokens: 0 };
  };
}
