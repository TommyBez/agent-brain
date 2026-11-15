import { fingerprint } from "../../canonical-json";
import { JEV_MODEL } from "./jev";
import { recordKeys } from "./keys";
import type { Evaluation, Judgment } from "./types";

export type CompactJudgment = Pick<
  Evaluation,
  "answers" | "model" | "promptVersion" | "inputTokens" | "outputTokens"
> & { evaluationKey: string };

/** Drop repeated page text/prompts, including verification nested in decisions.
 * Keep exact request identity and typed answers (including all probabilities).
 */
export function compactRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactRecord);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "judgments" && Array.isArray(entry)
        ? entry.map((judgment: Judgment | CompactJudgment) => {
            const { answers, model, promptVersion, inputTokens, outputTokens } =
              judgment;
            return {
              evaluationKey:
                "evaluationKey" in judgment
                  ? judgment.evaluationKey
                  : recordKeys.evaluation(
                      fingerprint({
                        model: JEV_MODEL,
                        request: {
                          state: judgment.state,
                          questions: judgment.questions,
                        },
                      }),
                    ),
              answers,
              model,
              promptVersion,
              inputTokens,
              outputTokens,
            } satisfies CompactJudgment;
          })
        : compactRecord(entry),
    ]),
  );
}
