import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PAGE_TYPES } from "../lib/brain/types";
import { EDITOR_MODEL } from "../lib/maintenance/consolidator/budget";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { type GatewayCall, gatewayRequest } from "../lib/maintenance/gateway";
import { writeWithFeedback } from "../lib/mcp/write-feedback";
import { FakeBrain, type Page, toolDefinitions } from "./skill-eval/brain";

async function main() {
  // Opt-in live eval. Synthetic in-memory pages only; no MCP, DB or Brain export.
  const out = resolve(process.argv[2] ?? ".evals/write-feedback");
  await mkdir(out, { recursive: true });
  const syncsOnly = process.argv.includes("--syncs-only");
  const judgments: unknown[] = [];
  const send: GatewayCall = async <T>(
    path: Parameters<GatewayCall>[0],
    body: unknown,
    options?: { signal?: AbortSignal },
  ) => {
    const start = performance.now();
    const response = await gatewayRequest<T>(path, body, options);
    judgments.push({
      request: body as EvaluationRequest,
      response,
      milliseconds: performance.now() - start,
    });
    return response;
  };
  const cases = [
    { markdown: "l'azienda X è stata fondata nel 2026", warns: false },
    { markdown: "Tizio lavora in Y dal 2020", warns: false },
    { markdown: "kick off del progetto il 20/02/2025", warns: false },
    {
      markdown: "## Aggiornamento 12/11\nIl prototipo è in beta.",
      warns: true,
    },
    {
      markdown: "## Stato (13/11)\nBeta\n## Stato precedente\nPrototipo",
      warns: true,
    },
  ];
  const examples: unknown[] = [];
  for (const type of syncsOnly ? [] : PAGE_TYPES) {
    for (const example of cases) {
      const operation = example.markdown.startsWith("## Aggiornamento")
        ? "append"
        : "write";
      const result = await writeWithFeedback(
        async () => ({ type, title: "Synthetic", markdown: example.markdown }),
        { operation, markdown: example.markdown },
        send,
      );
      examples.push({
        type,
        ...example,
        operation,
        evaluation: result.writeEvaluation,
        passed:
          !!result.writeEvaluation &&
          !!result.writeEvaluation.feedback === example.warns,
      });
    }
  }
  await writeFile(
    resolve(out, "examples.json"),
    JSON.stringify({ examples, judgments }, null, 2),
  );

  const exampleJudgments = judgments.length;
  const history = "kick off del progetto il 20/02/2025";
  const initial: Page = {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "project/iris",
    type: "project",
    title: "Iris",
    summary: "Progetto sintetico",
    markdown: `# Iris\n\n${history}\n\n## Stato\nPrototipo.`,
    aliases: [],
    tags: [],
    relationships: [],
    links: [],
    version: 1,
    expectedVersion: 0,
    reason: "fixture",
    source: "synthetic",
  };
  const brain = new FakeBrain([initial], {});
  type Message = {
    role: string;
    content?: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  };
  type ToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  };
  const instructions = (
    await readFile(resolve("lib/mcp/server.ts"), "utf8")
  ).match(/export const BRAIN_INSTRUCTIONS = `([\s\S]*?)`;/)?.[1];
  assert.ok(instructions);
  const messages: Message[] = [{ role: "system", content: instructions }];
  const turns: unknown[] = [];
  const syncPrompts: string[] = [];
  const syncResults: unknown[] = [];
  const tools = toolDefinitions.filter((tool) =>
    ["read", "write", "append", "resolve", "context"].includes(
      tool.function.name,
    ),
  );
  const stateSectionsIn = (markdown: string) =>
    (
      markdown.match(/^#{1,6}\s+(?:stato|aggiornamento|status|update)\b/gim) ??
      []
    ).length;
  async function call(tool: string, input: Record<string, unknown>) {
    if (tool === "write" || tool === "append") {
      return writeWithFeedback(
        async () => {
          const result = brain.call(tool, input) as Page & { error?: string };
          if (result.error) throw new Error(result.error);
          return result;
        },
        { operation: tool, markdown: String(input.markdown) },
        send,
      );
    }
    return brain.call(tool, input);
  }
  for (const [index, state] of [
    "Beta interna.",
    "Pilota con tre clienti.",
    "Rilascio pubblico.",
  ].entries()) {
    const prompt = `Sync ${index + 1}: Iris ora ha questo stato: ${state} Aggiorna la pagina conservando i fatti storici. Non è una nuova decisione.`;
    syncPrompts.push(prompt);
    messages.push({ role: "user", content: prompt });
    if (index === 0) {
      // Controlled fault injection guarantees that feedback is exercised even
      // when the agent would follow #41's writing guidance without an error.
      const args = {
        ref: initial.slug,
        expectedVersion: 1,
        markdown: "## Aggiornamento 12/11\nBeta interna.",
        reason: "synthetic fault injection",
        source: "synthetic sync 1",
      };
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "seed-log",
            type: "function",
            function: { name: "append", arguments: JSON.stringify(args) },
          },
        ],
      });
      const output = await call("append", args);
      turns.push({
        sync: 1,
        seeded: true,
        tool: "append",
        input: args,
        output,
      });
      messages.push({
        role: "tool",
        tool_call_id: "seed-log",
        content: JSON.stringify(output),
      });
    }
    let finished = false;
    for (let turn = 0; turn < 12; turn++) {
      const response = await gatewayRequest<{
        choices: { message: Message }[];
      }>("chat/completions", {
        model: EDITOR_MODEL,
        temperature: 0,
        messages,
        tools,
        max_tokens: 4000,
      });
      const message = response.choices[0].message;
      messages.push(message);
      turns.push({ sync: index + 1, turn, message });
      if (!message.tool_calls?.length) {
        finished = true;
        break;
      }
      for (const tool of message.tool_calls) {
        const input = JSON.parse(tool.function.arguments);
        let output: unknown;
        try {
          output = await call(tool.function.name, input);
        } catch (error) {
          output = { error: String(error) };
        }
        turns.push({
          sync: index + 1,
          turn,
          tool: tool.function.name,
          input,
          output,
        });
        messages.push({
          role: "tool",
          tool_call_id: tool.id,
          content: JSON.stringify(output),
        });
      }
    }
    // Record non-recovery as an outcome, without a repair prompt or harness edit.
    syncResults.push({
      sync: index + 1,
      expectedState: state,
      finished,
      statePresent: brain.pages[0].markdown.includes(state),
      historyPreserved: brain.pages[0].markdown.includes(history),
      stateSections: stateSectionsIn(brain.pages[0].markdown),
      page: structuredClone(brain.pages[0]),
    });
    await writeFile(
      resolve(out, "syncs.json"),
      JSON.stringify(
        {
          model: EDITOR_MODEL,
          setup: {
            instructions,
            tools,
            syncPrompts,
            seededLog: true,
            correctionInstruction: false,
          },
          turns,
          syncResults,
          judgments: judgments.slice(exampleJudgments),
          finalPage: brain.pages[0],
        },
        null,
        2,
      ),
    );
  }
  const finalPage = brain.pages[0];
  const stateSections = stateSectionsIn(finalPage.markdown);
  const failures = (examples as { passed: boolean }[]).filter(
    (example) => !example.passed,
  ).length;
  await writeFile(
    resolve(out, "summary.json"),
    JSON.stringify(
      {
        cases: examples.length,
        passed: examples.length - failures,
        failed: failures,
        syncs: 3,
        stateSections,
        historyPreserved: finalPage.markdown.includes(history),
        finalStateSectionCheck: stateSections <= 1,
        setup: {
          instructions,
          tools,
          syncPrompts,
          seededLog: true,
          correctionInstruction: false,
        },
        syncResults,
        finalPage,
        judgments: judgments.slice(exampleJudgments),
        turns,
      },
      null,
      2,
    ),
  );
  // Save the complete run before checking acceptance: a failure is evidence,
  // never a reason to rerun the agent or force a corrective write.
  assert.ok(
    stateSections <= 1,
    `expected at most one state section, got ${stateSections}`,
  );
  assert.ok(finalPage.markdown.includes(history));
  assert.equal(failures, 0, "live semantic acceptance examples");
  console.log(
    JSON.stringify({
      cases: examples.length,
      failed: failures,
      syncs: 3,
      stateSections,
      out,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
