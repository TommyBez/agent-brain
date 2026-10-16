import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/operations/jev/route";
import { fingerprint } from "../lib/canonical-json";
import {
  BASELINE_PROFILE,
  resolvePromptProfile,
} from "../lib/maintenance/consolidator/prompts";
import {
  preparationQuestions,
  screeningQuestions,
} from "../lib/maintenance/consolidator/questions";
import {
  checkJevRuntime,
  jevDiagnosticRequests,
} from "../lib/maintenance/consolidator/runtime-diagnostics";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import type { GatewayCall } from "../lib/maintenance/gateway";

test("runtime probe sends the six adopted prompts selected by the environment", async () => {
  const previous = process.env.JEV_PROMPT_PROFILE;
  try {
    process.env.JEV_PROMPT_PROFILE = "apo-2026-10-16-completo-italiano-v1";
    const requests = jevDiagnosticRequests();
    for (const [request, baseline, keys] of [
      [
        requests.pagina,
        screeningQuestions(false, BASELINE_PROFILE),
        ["duplicate", "residue"],
      ],
      [
        requests.collegamenti,
        screeningQuestions(true, BASELINE_PROFILE),
        ["link_ab", "link_ba"],
      ],
      [
        requests.consolidamento,
        preparationQuestions("duplicate", BASELINE_PROFILE),
        ["actionable", "destination"],
      ],
      [
        requests.conflitto,
        preparationQuestions("conflict", BASELINE_PROFILE),
        ["resolution"],
      ],
    ] as const) {
      for (const key of keys)
        assert.notDeepEqual(request.questions[key], baseline[key]);
    }
    const sent: EvaluationRequest[] = [];
    const send: GatewayCall = async <T>(path: string, body: unknown) => {
      assert.equal(path, "evaluate");
      const request = body as EvaluationRequest & { model: string };
      sent.push({ state: request.state, questions: request.questions });
      return {
        model: request.model,
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, q]) => [
            id,
            q.type === "boolean"
              ? { type: "boolean", probability: 0.9 }
              : {
                  type: "choice",
                  choice: Object.keys(q.criteria)[0],
                  probabilities: Object.fromEntries(
                    Object.keys(q.criteria).map((key, index) => [
                      key,
                      index === 0 ? 1 : 0,
                    ]),
                  ),
                },
          ]),
        ),
      } as T;
    };
    const result = await checkJevRuntime(send);
    assert.equal(result.profileId, process.env.JEV_PROMPT_PROFILE);
    assert.equal(
      result.profileHash,
      fingerprint(resolvePromptProfile().prompts),
    );
    assert.equal(result.checks.length, 4);
    assert.deepEqual(
      result.checks.map((c) => c.requestHash),
      sent.map(fingerprint),
    );
    assert.deepEqual(sent, Object.values(requests));
  } finally {
    if (previous === undefined) delete process.env.JEV_PROMPT_PROFILE;
    else process.env.JEV_PROMPT_PROFILE = previous;
  }
});

test("runtime diagnostics reject invalid bearer tokens before running Jev", async () => {
  for (const handler of [GET, POST]) {
    const response = await handler(
      new Request("https://brain.example/api/operations/jev", {
        method: handler === GET ? "GET" : "POST",
        headers: { authorization: "Bearer invalid-diagnostic-token" },
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("authorized runtime metadata requires no Gateway request", async () => {
  const previous = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = "runtime-test-secret";
    const response = await GET(
      new Request("https://brain.example/api/operations/jev", {
        headers: { authorization: "Bearer runtime-test-secret" },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).profileId, resolvePromptProfile().id);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
