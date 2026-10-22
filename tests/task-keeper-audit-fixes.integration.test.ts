import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { after, type TestContext } from "node:test";
import * as brain from "../lib/brain/service";
import { embeddingModel } from "../lib/brain/utils";
import { getPool } from "../lib/db";
import type { GatewayCall } from "../lib/maintenance/gateway";
import { runTaskKeeperPhase } from "../lib/maintenance/task-keeper";
import { maintenanceEmbedding } from "../lib/maintenance/task-keeper/apply";
import { pendingDuplicatePairs } from "../lib/maintenance/task-keeper/hygiene";
import {
  prepareKeeperHygiene,
  prepareTaskKeeper,
} from "../lib/maintenance/task-keeper/steps";
import { openSuggestion } from "../lib/maintenance/task-keeper/store";
import { taskCandidates } from "../lib/maintenance/task-links/run";
import type { TaskPhaseContext } from "../lib/maintenance/task-phase";
import { ownerActor, systemActor } from "../lib/tasks/actors";
import {
  corpusFingerprint,
  nightlyTaskRetrieval,
} from "../lib/tasks/retrieval";
import { createTask } from "../lib/tasks/service";
import {
  decideTaskSuggestion,
  listTaskSuggestions,
} from "../lib/tasks/suggestions";

// Audit fixes for the task keeper and the nightly task phases: proposals held
// back by the 3-open cap stay pending, oversized pages are never marked done,
// and nightly work never spends the interactive query key.

type Call = { url: string; auth: string | null; body: string };

const COMMITMENT = /^- (.+?) → (.+?)(?: \((.+?)\))?\s*$/;

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Jev: yes/no by question id and the state it is asked about. */
function jevAnswer(id: string, state: Record<string, unknown>): number {
  const text = (value: unknown) => JSON.stringify(value ?? "");
  if (id === "screening")
    return text((state.pages as unknown[])[0]).includes("→") ? 0.95 : 0.05;
  if (id.startsWith("passage_")) {
    const units = state.units as { text: string }[];
    return units[Number(id.slice(8))].text.includes("→") ? 0.9 : 0.1;
  }
  if (
    [
      "explicit_commitment",
      "actor_supported",
      "due_text_supported",
      "due_date_supported",
    ].includes(id)
  )
    return 0.95;
  if (id.startsWith("duplicate_")) {
    const existing = (state.existing as Record<string, { title: string }>)[
      id.slice("duplicate_".length)
    ];
    return normalize((state.new as { title: string }).title) ===
      normalize(existing.title)
      ? 0.95
      : 0.05;
  }
  if (id === "same_work") {
    const tasks = state.tasks as Record<string, { title: string }>;
    return normalize(tasks.a.title) === normalize(tasks.b.title) ? 0.95 : 0.05;
  }
  const page = /^(done|canceled|moved)_(p\d+)$/.exec(id);
  if (page) {
    const pages = state.pages as Record<string, { markdown: string }>;
    const title = (state.task as { title: string }).title;
    return page[1] === "done" &&
      pages[page[2]].markdown.includes(`Fatto: ${title}`)
      ? 0.95
      : 0.05;
  }
  return 0.05;
}

function vector(text: string): number[] {
  return Array.from(
    { length: 1536 },
    (_, index) => ((text.charCodeAt(index % text.length) + index) % 13) + 1,
  );
}

/** Fake AI Gateway: Jev, DeepSeek and embeddings, recording every call. */
function fakeProviders(t: TestContext) {
  const calls: Call[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        auth: headers.get("authorization"),
        body,
      });
      const request = JSON.parse(body);
      if (String(url).endsWith("/v1/evaluate")) {
        const answers: Record<string, unknown> = {};
        for (const id of Object.keys(request.questions))
          answers[id] = {
            type: "boolean",
            probability: jevAnswer(id, request.state),
          };
        return Response.json({
          model: "typesafe-ai/jev-1.14.0",
          answers,
          usage: { inputTokens: 100, outputTokens: 1 },
          providerMetadata: { gateway: { cost: "0.0000042" } },
        });
      }
      if (String(url).endsWith("/v1/chat/completions")) {
        const content = JSON.parse(request.messages[1].content) as {
          units: { id: string; text: string }[];
          candidatePassageIds: string[];
        };
        const items = content.candidatePassageIds.flatMap((id) => {
          const unit = content.units.find((candidate) => candidate.id === id);
          const match = COMMITMENT.exec(unit?.text.trim() ?? "");
          return match
            ? [
                {
                  passageIds: [id],
                  title: match[2],
                  actorNames: [match[1]],
                  dueText: match[3] ?? null,
                  dueDate: null,
                  projectRef: null,
                },
              ]
            : [];
        });
        return Response.json({
          id: `gen-${calls.length}`,
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ items }) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.00002 },
        });
      }
      if (String(url).endsWith("/v1/embeddings")) {
        const inputs: string[] = Array.isArray(request.input)
          ? request.input
          : [request.input];
        return Response.json({
          data: inputs.map((text, index) => ({
            index,
            embedding: vector(text),
          })),
        });
      }
      throw new Error(`Unexpected provider call ${String(url)}`);
    },
  );
  return calls;
}

async function setupOwner(
  t: TestContext,
  label: string,
  env: Record<string, string> = {},
) {
  const pool = getPool();
  const ownerId = randomUUID();
  const email = `keeper-audit-${label}-${ownerId}@example.invalid`;
  const values: Record<string, string> = {
    BRAIN_OWNER_EMAIL: [process.env.BRAIN_OWNER_EMAIL, email]
      .filter(Boolean)
      .join(","),
    BRAIN_QUERY_EMBEDDINGS: "false",
    AI_GATEWAY_API_KEY: "test-only",
    ...env,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  t.mock.method(
    createRequire(import.meta.url)("next/cache"),
    "revalidateTag",
    () => undefined,
  );
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Keeper Audit',$2,true,now(),now())`,
    [ownerId, email],
  );
  t.after(async () => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    for (const table of [
      "brain_task_suggestions",
      "brain_task_parties",
      "brain_task_links",
      "brain_task_events",
      "brain_task_dependencies",
      "brain_tasks",
      "brain_task_recurrences",
      "brain_task_settings",
      "brain_task_extraction_rejections",
      "brain_consolidation_spend",
      "brain_consolidation_records",
      "brain_activity",
      "brain_pages",
    ])
      await pool.query(`DELETE FROM ${table} WHERE owner_id = $1`, [ownerId]);
    await pool.query("DELETE FROM brain_agent_clients WHERE owner_id = $1", [
      ownerId,
    ]);
    await pool.query("DELETE FROM brain_agents WHERE owner_id = $1", [ownerId]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
  });
  return ownerId;
}

function night(ownerId: string) {
  return runTaskKeeperPhase({
    ownerId,
    runId: randomUUID(),
    runDate: "2026-10-21",
    jobId: randomUUID(),
    attempts: 1,
    scope: "tasks",
  } satisfies TaskPhaseContext);
}

/** Takes every suggestion slot of a task with unrelated open suggestions. */
async function fillSlots(ownerId: string, taskId: string) {
  const keeper = await systemActor(ownerId, "task_keeper");
  for (let index = 0; index < 3; index++)
    assert.equal(
      await openSuggestion(getPool(), {
        ownerId,
        taskId,
        kind: "new_source",
        citations: [],
        dedupeKey: `filler:${taskId}:${index}`,
        payload: { action: "link" },
        createdByAgentId: keeper.agentId,
      }),
      "opened",
    );
}

/** The owner dismisses one filler suggestion, freeing a slot. */
async function freeSlot(ownerId: string, taskId: string) {
  const { rows } = await getPool().query(
    "SELECT id FROM brain_task_suggestions WHERE owner_id = $1 AND dedupe_key = $2",
    [ownerId, `filler:${taskId}:0`],
  );
  await decideTaskSuggestion(await ownerActor(ownerId), {
    id: rows[0].id,
    decision: "dismissed",
  });
}

/** Kinds of the task's open suggestions, sorted. */
async function openKinds(ownerId: string, ref: string) {
  return (await listTaskSuggestions(ownerId, { taskRef: ref }))
    .map((suggestion) => suggestion.kind)
    .sort();
}

/** Backdates a page: newest first, it would sort after every newer page. */
async function backdate(ownerId: string, pageId: string, days: number) {
  await getPool().query(
    "UPDATE brain_pages SET updated_at = now() - make_interval(days => $3) WHERE owner_id = $1 AND id = $2",
    [ownerId, pageId, days],
  );
}

after(async () => {
  if (process.env.RUN_DB_TESTS === "1") await getPool().end();
});

test("item vectors go through the maintenance gateway; failures fall back to text", async () => {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const send = (async (path: string, body: Record<string, unknown>) => {
    sent.push({ path, body });
    return { data: [{ index: 0, embedding: vector("x") }] };
  }) as unknown as GatewayCall;
  const embedded = await maintenanceEmbedding(send)("Inviare il preventivo");
  assert.deepEqual(sent, [
    {
      path: "embeddings",
      body: {
        model: embeddingModel(),
        input: "Inviare il preventivo",
        dimensions: 1536,
      },
    },
  ]);
  assert.equal(embedded?.embeddingModel, embeddingModel());
  assert.equal(embedded?.embedding.length, 1536);
  const failing = (async () => {
    throw new Error("unavailable");
  }) as unknown as GatewayCall;
  assert.equal(await maintenanceEmbedding(failing)("x"), null);
  const malformed = (async () => ({ data: [] })) as unknown as GatewayCall;
  assert.equal(await maintenanceEmbedding(malformed)("x"), null);
});

test(
  "task keeper: proposals held back by the 3-open cap stay pending until a slot frees",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    const ownerId = await setupOwner(t, "cap");
    const calls = fakeProviders(t);
    const owner = await ownerActor(ownerId);
    const write = (input: Record<string, unknown>) =>
      brain.write(ownerId, { expectedVersion: 0, ...input });

    await t.test(
      "may_be_done: the hygiene unit is retried from the cache",
      async () => {
        const minute = await write({
          title: "Esito report clinico",
          type: "note",
          markdown: "Fatto: Preparare il report clinico\n",
        });
        const report = await createTask(owner, {
          title: "Preparare il report clinico",
          description: `Fonte: /pages/${minute.id}`,
        });
        await fillSlots(ownerId, report.task.id);

        const first = await night(ownerId);
        assert.equal(first.status, "succeeded", JSON.stringify(first));
        assert.equal(first.cappedSuggestions, 1);
        assert.deepEqual(await openKinds(ownerId, report.task.ref), [
          "new_source",
          "new_source",
          "new_source",
        ]);
        // Tasks with a free slot are evaluated first.
        const archive = await createTask(owner, {
          title: "Archiviare i verbali",
          description: `Fonte: /pages/${minute.id}`,
        });
        assert.deepEqual((await prepareKeeperHygiene(ownerId)).taskIds, [
          archive.task.id,
          report.task.id,
        ]);

        await freeSlot(ownerId, report.task.id);
        const before = calls.length;
        const second = await night(ownerId);
        assert.equal(second.status, "succeeded", JSON.stringify(second));
        assert.equal(second.cappedSuggestions, 0);
        const [done] = (
          await listTaskSuggestions(ownerId, { taskRef: report.task.ref })
        ).filter((suggestion) => suggestion.kind === "may_be_done");
        assert.ok(done, "the freed slot takes may_be_done");
        assert.equal(done.citations[0].pageId, minute.id);
        assert.ok(
          calls
            .slice(before)
            .filter((call) => call.url.endsWith("/v1/evaluate"))
            .every(
              (call) =>
                JSON.parse(call.body).state?.task?.title !==
                "Preparare il report clinico",
            ),
          "the retry is answered by the evaluation cache",
        );
        assert.deepEqual((await prepareKeeperHygiene(ownerId)).taskIds, []);
      },
    );

    await t.test(
      "duplicate: the pair stays pending and pairs at the cap come last",
      async () => {
        const kickoff = await createTask(owner, {
          title: "Organizzare il kick-off con il cliente",
        });
        const kickoffAgain = await createTask(owner, {
          title: "Organizzare il kick-off con il cliente",
        });
        const contract = await createTask(owner, {
          title: "Rinnovare il contratto di manutenzione",
        });
        const contractAgain = await createTask(owner, {
          title: "Rinnovare il contratto di manutenzione",
        });
        await fillSlots(ownerId, kickoffAgain.task.id);
        const ids = (
          pairs: Awaited<ReturnType<typeof pendingDuplicatePairs>>,
        ) => pairs.map((pair) => [pair.a.id, pair.b.id]);
        assert.deepEqual(ids(await pendingDuplicatePairs(ownerId, 1)), [
          [contract.task.id, contractAgain.task.id],
        ]);

        const first = await night(ownerId);
        assert.equal(first.status, "succeeded", JSON.stringify(first));
        assert.equal(first.cappedSuggestions, 1);
        assert.deepEqual(await openKinds(ownerId, contractAgain.task.ref), [
          "duplicate",
        ]);
        assert.ok(
          !(await openKinds(ownerId, kickoffAgain.task.ref)).includes(
            "duplicate",
          ),
        );
        assert.deepEqual(ids(await pendingDuplicatePairs(ownerId)), [
          [kickoff.task.id, kickoffAgain.task.id],
        ]);

        await freeSlot(ownerId, kickoffAgain.task.id);
        const second = await night(ownerId);
        assert.equal(second.cappedSuggestions, 0);
        const [duplicate] = (
          await listTaskSuggestions(ownerId, { taskRef: kickoffAgain.task.ref })
        ).filter((suggestion) => suggestion.kind === "duplicate");
        assert.ok(duplicate, "the freed slot takes the duplicate");
        assert.equal(duplicate.relatedRef, kickoff.task.ref);
        assert.deepEqual(ids(await pendingDuplicatePairs(ownerId)), []);
      },
    );

    await t.test(
      "new_source: the page stays pending without failing the run",
      async () => {
        const quote = await createTask(owner, {
          title: "Inviare il preventivo al fornitore",
        });
        await fillSlots(ownerId, quote.task.id);
        const followUp = await write({
          title: "Verbale 20/10/2026",
          type: "note",
          markdown:
            "# Verbale 20/10/2026\n\n- Giulia → Inviare il preventivo al fornitore (entro venerdì)\n",
        });

        const first = await night(ownerId);
        assert.equal(first.status, "succeeded", JSON.stringify(first));
        assert.equal(first.halt, null);
        assert.equal(first.cappedPages, 1);
        assert.equal(first.newSources, 0);
        assert.equal(first.created, 0);
        assert.equal(first.remainingPages, 0);
        assert.deepEqual((await prepareTaskKeeper(ownerId)).pageIds, [
          followUp.id,
        ]);
        // A page waiting for a slot goes after other pending pages.
        const notes = await write({
          title: "Note sparse",
          type: "note",
          markdown: "Il cliente preferisce report in PDF.",
        });
        await backdate(ownerId, notes.id, 2);
        assert.deepEqual((await prepareTaskKeeper(ownerId)).pageIds, [
          notes.id,
          followUp.id,
        ]);

        await freeSlot(ownerId, quote.task.id);
        const second = await night(ownerId);
        assert.equal(second.status, "succeeded", JSON.stringify(second));
        assert.equal(second.cappedPages, 0);
        assert.equal(second.newSources, 1);
        assert.equal(second.created, 0);
        const [source] = (
          await listTaskSuggestions(ownerId, { taskRef: quote.task.ref })
        ).filter(
          (suggestion) =>
            suggestion.kind === "new_source" &&
            suggestion.citations[0]?.pageId === followUp.id,
        );
        assert.ok(source, "the freed slot takes the new source");
        assert.deepEqual((await prepareTaskKeeper(ownerId)).pageIds, []);
      },
    );
  },
);

test(
  "task keeper: a page over Jev's limit is never marked done and keeps the run partial",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    const ownerId = await setupOwner(t, "oversized");
    const calls = fakeProviders(t);
    const filler = "Discussione generale sul monitoraggio, senza decisioni.\n";
    const transcript = await brain.write(ownerId, {
      expectedVersion: 0,
      title: "Trascrizione riunione 15/10/2026",
      type: "note",
      markdown: `# Trascrizione\n\n${filler.repeat(Math.ceil(120_000 / filler.length))}- Anna → Inviare il report di monitoraggio (entro venerdì)\n`,
    });
    const snapshots = async () =>
      (
        await getPool().query(
          `SELECT count(*)::int AS count FROM brain_consolidation_records
           WHERE owner_id = $1 AND record_key LIKE 'task-keeper:snapshot:%' AND payload->'page'->>'id' = $2`,
          [ownerId, transcript.id],
        )
      ).rows[0].count;

    const first = await night(ownerId);
    assert.equal(first.status, "partial", JSON.stringify(first));
    assert.equal(first.halt, null, "not a run limit");
    assert.equal(first.oversizedPages, 1);
    assert.equal(first.remainingPages, 1);
    assert.equal(first.created, 0);
    assert.ok(
      calls.every((call) => !call.body.includes("Anna")),
      "never sent to a model",
    );
    assert.deepEqual((await prepareTaskKeeper(ownerId)).pageIds, [
      transcript.id,
    ]);
    assert.equal(await snapshots(), 1);

    const second = await night(ownerId);
    assert.equal(second.status, "partial", JSON.stringify(second));
    assert.equal(second.oversizedPages, 1);
    assert.equal(second.requests, 0);
    assert.equal(await snapshots(), 1, "no new snapshot for a known page");

    const notes = await brain.write(ownerId, {
      expectedVersion: 0,
      title: "Note sparse",
      type: "note",
      markdown: "Il cliente preferisce report in PDF.",
    });
    await backdate(ownerId, notes.id, 2);
    assert.deepEqual((await prepareTaskKeeper(ownerId)).pageIds, [
      notes.id,
      transcript.id,
    ]);
  },
);

test(
  "nightly task phases never use the query key; keeper vectors use the maintenance gateway",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    const queryKey = `query-key-${randomUUID()}`;
    const maintenanceKey = `maintenance-key-${randomUUID()}`;
    const ownerId = await setupOwner(t, "keys", {
      BRAIN_QUERY_EMBEDDINGS: "true",
      BRAIN_EMBEDDING_API_KEY: queryKey,
      AI_GATEWAY_API_KEY: maintenanceKey,
    });
    const calls = fakeProviders(t);
    const owner = await ownerActor(ownerId);
    const conciliator = await systemActor(ownerId, "consolidator");
    await brain.write(ownerId, {
      expectedVersion: 0,
      title: "Report clinico",
      type: "note",
      markdown: "Il report clinico segue il modello in due sezioni.",
    });
    const report = await createTask(owner, {
      title: "Preparare il report clinico",
    });
    const withQueryKey = () =>
      calls.filter((call) => call.auth === `Bearer ${queryKey}`);
    calls.length = 0;

    const retrieval = await nightlyTaskRetrieval(
      ownerId,
      randomUUID(),
      report.task.id,
      conciliator.agentId,
      await corpusFingerprint(getPool(), ownerId),
      null,
    );
    assert.equal(retrieval.searched, true);
    await taskCandidates(
      ownerId,
      {
        id: report.task.id,
        title: "Preparare il report clinico",
        projectPageId: null,
      },
      null,
    );
    assert.deepEqual(withQueryKey(), [], "no vector: text and graph only");

    await brain.write(ownerId, {
      expectedVersion: 0,
      title: "Verbale 20/10/2026",
      type: "note",
      markdown: "- Giulia → Inviare il preventivo al cliente\n",
    });
    const result = await night(ownerId);
    assert.equal(result.created, 1, JSON.stringify(result));
    const itemVectors = calls.filter(
      (call) =>
        call.url.endsWith("/v1/embeddings") &&
        JSON.parse(call.body).input ===
          "Inviare il preventivo al cliente\n\n- Giulia → Inviare il preventivo al cliente",
    );
    assert.equal(itemVectors.length, 1);
    assert.equal(itemVectors[0].auth, `Bearer ${maintenanceKey}`);

    // Control: an interactive search does use the query key.
    calls.length = 0;
    await brain.search(ownerId, { query: `probe ${randomUUID()}` });
    assert.equal(withQueryKey().length, 1);
  },
);
