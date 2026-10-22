import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { after, type TestContext } from "node:test";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";
import { findConsolidationRecord } from "../lib/maintenance/consolidator/store";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import {
  applyLinkAnalysis,
  type LinkAnalysis,
} from "../lib/maintenance/task-links/apply";
import {
  AUTO_APPLY_OFF,
  autoApplyGates,
  roleReviewMetrics,
} from "../lib/maintenance/task-links/gate";
import {
  runTaskLinksPhase,
  type TaskLinksResult,
} from "../lib/maintenance/task-links/index";
import { planTaskLinks } from "../lib/maintenance/task-links/nightly";
import { ownerActor, resolveActor, systemActor } from "../lib/tasks/actors";
import { createTask, readTask, updateTask } from "../lib/tasks/service";
import { decideTaskLink } from "../lib/tasks/suggestions";

async function knowledgeState(ownerId: string) {
  const { rows } = await getPool().query(
    `SELECT
       (SELECT count(*)::int FROM brain_pages WHERE owner_id = $1) AS pages,
       (SELECT coalesce(sum(version), 0)::int FROM brain_pages WHERE owner_id = $1) AS versions,
       (SELECT max(updated_at) FROM brain_pages WHERE owner_id = $1) AS updated,
       (SELECT count(*)::int FROM brain_links WHERE owner_id = $1) AS links,
       (SELECT count(*)::int FROM brain_revisions WHERE owner_id = $1) AS revisions`,
    [ownerId],
  );
  return rows[0];
}

async function linkRows(ownerId: string) {
  const { rows } = await getPool().query(
    `SELECT task_id, page_id, role, origin, status, confidence, evidence, updated_at
     FROM brain_task_links WHERE owner_id = $1 ORDER BY task_id, page_id, role`,
    [ownerId],
  );
  return rows;
}

after(async () => {
  if (process.env.RUN_DB_TESTS === "1") await getPool().end();
});

function vectorFor(text: string): number[] {
  const hash = createHash("sha256").update(text).digest();
  return Array.from(
    { length: 1536 },
    (_, index) => ((hash[index % 32] + index) % 17) / 17 + 0.01,
  );
}

test(
  "nightly task_links: vectors, rules, retrieval and Jev suggestions converge to zero work",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `task-links-nightly-${ownerId}@example.invalid`;
    const env = {
      owner: process.env.BRAIN_OWNER_EMAIL,
      embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
      key: process.env.AI_GATEWAY_API_KEY,
    };
    process.env.BRAIN_OWNER_EMAIL = [env.owner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    process.env.AI_GATEWAY_API_KEY = "test-only";
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    // The fake AI Gateway: deterministic task vectors and Jev answers by page title.
    const calls = { evaluate: 0, embeddings: 0, inputs: [] as string[][] };
    let failEvaluate = false;
    let answer = (_key: string, title: string): number => {
      if (title === "Formato del report trimestrale") return 0.95;
      if (title === "Giulia Conti") return 0.9;
      if (title === "Dati arruolamento") return 0.85;
      if (title === "Nuovo protocollo del report trimestrale") return 0.88;
      if (title === "Calendario regolatorio") return 0.65;
      return 0.2;
    };
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith("/v1/embeddings")) {
          calls.embeddings++;
          calls.inputs.push(body.input);
          return Response.json({
            data: (body.input as string[]).map((text, index) => ({
              index,
              embedding: vectorFor(text),
            })),
          });
        }
        if (String(url).endsWith("/v1/evaluate")) {
          calls.evaluate++;
          if (failEvaluate) return new Response("{}", { status: 500 });
          const request = body as EvaluationRequest & { model: string };
          const pages = (
            request.state as { pages: Record<string, { title: string }> }
          ).pages;
          return Response.json({
            model: request.model,
            answers: Object.fromEntries(
              Object.keys(request.questions).map((key) => [
                key,
                {
                  type: "boolean",
                  probability: answer(key, pages[key.split("_")[1]].title),
                },
              ]),
            ),
            usage: { inputTokens: 1000, outputTokens: 1 },
          });
        }
        throw new Error(`Unexpected network call: ${String(url)}`);
      },
    );
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Nightly Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    const night = (runId: string): Promise<TaskLinksResult> =>
      runTaskLinksPhase({
        ownerId,
        runId,
        runDate: "2026-10-21",
        jobId: randomUUID(),
        attempts: 1,
        scope: "nightly",
      });
    try {
      const write = (input: Record<string, unknown>) =>
        brain.write(ownerId, { expectedVersion: 0, ...input });
      const project = await write({
        title: "Report studi clinici Farmalab",
        type: "project",
        markdown: "Report trimestrale sugli studi clinici di Farmalab.",
      });
      const format = await write({
        title: "Formato del report trimestrale",
        type: "decision",
        markdown: "Il report trimestrale usa il modello in due sezioni.",
        links: [{ targetRef: project.id, type: "decided_in" }],
      });
      const giulia = await write({
        title: "Giulia Conti",
        type: "person",
        markdown: "Responsabile qualità di Farmalab; approva il report.",
      });
      await write({
        title: "Convegno di farmacologia",
        type: "note",
        markdown: "Interventi sugli studi clinici di fase II.",
      });
      const enrolment = await write({
        title: "Dati arruolamento",
        type: "note",
        markdown: "Pazienti arruolati negli studi clinici per il report.",
      });
      await write({
        title: "Calendario regolatorio",
        type: "note",
        markdown: "Scadenze regolatorie degli studi.",
        links: [{ targetRef: project.id, type: "part_of" }],
      });
      const owner = await ownerActor(ownerId);
      const report = await createTask(owner, {
        title: "Preparare il report trimestrale per Giulia Conti",
        acceptanceCriteria: ["Dati di arruolamento aggiornati"],
        projectRef: project.id,
      });
      const calendar = await createTask(owner, {
        title: "Aggiornare il calendario degli studi clinici",
      });
      const agent = await resolveActor(ownerId, {
        ownerId,
        scopes: ["brain:read", "brain:write"],
        kind: "oauth",
        clientId: `nightly-${ownerId.slice(0, 8)}`,
      });
      const triage = await createTask(agent, {
        title: "Rivedere il report degli studi clinici",
        origin: "owner_request",
        ownerQuote: "tieni traccia della revisione",
        idempotencyKey: `nightly-${ownerId}`,
      });
      const conciliator = await systemActor(ownerId, "consolidator");
      let knowledge = await knowledgeState(ownerId);

      await t.test(
        "first night: vectors, one Jev request per task, suggestions only",
        async () => {
          const result = await night("r1");
          assert.equal(result.status, "succeeded");
          assert.equal(result.halt, null);
          assert.equal(result.vectorsEmbedded, 3);
          assert.equal(calls.embeddings, 1);
          assert.equal(result.tasksConsidered, 2); // triage stays out of Jev
          assert.equal(result.requests, 2);
          assert.equal(calls.evaluate, 2);
          assert.equal(result.unitsReused, 0);
          assert.equal(result.remainingTasks, 0);
          assert.ok(result.suggested > 0);
          assert.equal(result.spendNano, 2 * 1000 * 42);
          assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
          assert.deepEqual(result.autoApply, AUTO_APPLY_OFF);

          const { links } = await readTask(owner, { ref: report.task.ref });
          const byPage = (id: string) =>
            links.filter((link) => link.page.id === id);
          assert.deepEqual(
            byPage(giulia.id).map((link) => [
              link.role,
              link.origin,
              link.status,
              link.confidence,
            ]),
            [["stakeholder", "consolidator", "suggested", 0.9]],
          );
          assert.deepEqual(
            byPage(format.id).map((link) => [
              link.role,
              link.origin,
              link.status,
              link.confidence,
            ]),
            [["decision", "rule", "suggested", 0.95]],
          );
          assert.deepEqual(
            byPage(enrolment.id).map((link) => [
              link.role,
              link.origin,
              link.status,
            ]),
            [["context", "consolidator", "suggested"]],
          );
          assert.ok(
            links.every(
              (link) =>
                link.status !== "active" || link.origin !== "consolidator",
            ),
          );
          const vectors = await pool.query(
            `SELECT count(*)::int AS n FROM brain_tasks WHERE owner_id = $1 AND embedding IS NOT NULL AND semantic_fingerprint IS NOT NULL`,
            [ownerId],
          );
          assert.equal(vectors.rows[0].n, 3);
          const triageLinks = await pool.query(
            `SELECT count(*)::int AS n FROM brain_task_links WHERE owner_id = $1 AND task_id = $2 AND origin = 'consolidator'`,
            [ownerId, triage.task.id],
          );
          assert.equal(triageLinks.rows[0].n, 0);
          const events = await pool.query(
            `SELECT count(*)::int AS n FROM brain_task_events WHERE owner_id = $1 AND action = 'links_changed'
             AND actor_agent_id = $2 AND payload->>'basis' = 'jev'`,
            [ownerId, conciliator.agentId],
          );
          assert.equal(events.rows[0].n, 2);
          const receipts = await pool.query(
            `SELECT count(*)::int AS n FROM brain_consolidation_records WHERE owner_id = $1 AND kind = 'receipt' AND record_key LIKE 'task-link:apply:%'`,
            [ownerId],
          );
          assert.equal(receipts.rows[0].n, 2);
        },
      );

      await t.test(
        "an unchanged night makes zero requests and changes nothing; replays are harmless",
        async () => {
          const before = await linkRows(ownerId);
          const events = async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM brain_task_events WHERE owner_id = $1",
                [ownerId],
              )
            ).rows[0].n;
          const eventCount = await events();
          const second = await night("r2");
          assert.equal(second.status, "succeeded");
          assert.equal(second.requests, 0);
          assert.equal(second.vectorsEmbedded, 0);
          assert.equal(second.unitsReused, 2);
          assert.equal(second.suggested, 0);
          assert.equal(second.retracted, 0);
          assert.equal(second.spendNano, 0);
          assert.equal(calls.evaluate, 2);
          assert.equal(calls.embeddings, 1);
          assert.deepEqual(await linkRows(ownerId), before);
          assert.equal(await events(), eventCount);
          // The same Workflow run replayed, and a direct re-apply of a stored unit.
          const replay = await night("r1");
          assert.equal(replay.requests, 0);
          assert.deepEqual(await linkRows(ownerId), before);
          const { rows } = await pool.query(
            `SELECT record_key FROM brain_consolidation_records WHERE owner_id = $1 AND run_id = 'r1' AND record_key LIKE 'task-link:analysis:%' LIMIT 1`,
            [ownerId],
          );
          const analysis = await findConsolidationRecord<LinkAnalysis>(
            ownerId,
            rows[0].record_key,
          );
          assert.ok(analysis);
          const applied = await applyLinkAnalysis(
            ownerId,
            conciliator.agentId,
            analysis,
            AUTO_APPLY_OFF,
            "r1",
          );
          assert.equal(applied.status, "replayed");
          assert.deepEqual(await linkRows(ownerId), before);
          assert.deepEqual(await knowledgeState(ownerId), knowledge);
        },
      );

      await t.test(
        "a new relevant page is suggested to an open task the same night",
        async () => {
          const page = await write({
            title: "Nuovo protocollo del report trimestrale",
            type: "note",
            markdown:
              "Nuovo protocollo per preparare il report trimestrale di Farmalab.",
          });
          knowledge = await knowledgeState(ownerId);
          const result = await night("r3");
          assert.equal(result.status, "succeeded");
          assert.equal(result.requests, 1);
          assert.equal(result.unitsReused, 1);
          const { links } = await readTask(owner, { ref: report.task.ref });
          const added = links.filter((link) => link.page.id === page.id);
          assert.equal(added.length, 1);
          assert.equal(added[0].status, "suggested");
          assert.equal(added[0].confidence, 0.88);
        },
      );

      await t.test(
        "after a fingerprint change, low scores retract consolidator links; decided rows stay",
        async () => {
          await decideTaskLink(owner, report.task.ref, {
            pageRef: giulia.id,
            role: "stakeholder",
            decision: "rejected",
          });
          await decideTaskLink(owner, report.task.ref, {
            pageRef: enrolment.id,
            role: "context",
            decision: "active",
          });
          // The auto-apply gate reads the owner's decisions on consolidator links.
          const metrics = await roleReviewMetrics(pool, ownerId);
          assert.deepEqual(
            [
              metrics.stakeholder.reviews,
              metrics.stakeholder.rejected,
              metrics.stakeholder.recentRejectionRate,
            ],
            [1, 1, 1],
          );
          assert.deepEqual(
            [
              metrics.context.reviews,
              metrics.context.accepted,
              metrics.context.acceptance,
            ],
            [1, 1, 1],
          );
          assert.equal(metrics.decision.reviews, 0);
          const gates = await autoApplyGates(pool, ownerId);
          assert.ok(gates.every((gate) => !gate.enabled));
          assert.ok(gates.find((gate) => gate.role === "stakeholder")?.killed);
          const decided = (await linkRows(ownerId)).filter(
            (row) =>
              row.task_id === report.task.id &&
              [giulia.id, enrolment.id].includes(row.page_id),
          );
          const current = await readTask(owner, { ref: report.task.ref });
          await updateTask(owner, {
            ref: report.task.ref,
            expectedVersion: current.task.version,
            patch: {
              description: "Includere anche gli studi chiusi nel trimestre.",
            },
          });
          answer = () => 0.1;
          const result = await night("r4");
          assert.equal(result.status, "succeeded");
          assert.equal(result.vectorsEmbedded, 1);
          assert.equal(result.requests, 1);
          assert.ok(result.retracted >= 1);
          const after = await linkRows(ownerId);
          assert.deepEqual(
            after.filter(
              (row) =>
                row.task_id === report.task.id &&
                [giulia.id, enrolment.id].includes(row.page_id),
            ),
            decided,
          );
          const mine = after.filter((row) => row.task_id === report.task.id);
          assert.ok(
            mine
              .filter(
                (row) =>
                  row.origin === "consolidator" &&
                  row.status !== "rejected" &&
                  row.page_id !== enrolment.id,
              )
              .every((row) => row.status === "retracted"),
          );
          const rule = mine.find((row) => row.page_id === format.id);
          assert.equal(rule?.status, "suggested");
          assert.equal(rule?.origin, "rule");
          assert.equal(rule?.confidence, 0.1);
        },
      );

      await t.test(
        "provider and budget failures end the phase partial without changing links",
        async () => {
          const current = await readTask(owner, { ref: report.task.ref });
          await updateTask(owner, {
            ref: report.task.ref,
            expectedVersion: current.task.version,
            patch: { description: "Includere gli studi chiusi e sospesi." },
          });
          const before = await linkRows(ownerId);
          failEvaluate = true;
          const failed = await night("r5");
          failEvaluate = false;
          assert.equal(failed.status, "partial");
          assert.equal(failed.halt, "provider");
          assert.equal(failed.remainingTasks, 2);
          const unchanged = (rows: Awaited<ReturnType<typeof linkRows>>) =>
            rows.filter((row) => row.evidence?.basis !== "retrieval");
          assert.deepEqual(
            unchanged(await linkRows(ownerId)),
            unchanged(before),
          );

          const other = `task-links-budget-${randomUUID()}`;
          await pool.query(
            `INSERT INTO brain_consolidation_spend (owner_id, run_id, model, day, purpose, actual_nano)
           VALUES ($1, 'budget', 'typesafe-ai/jev-1.14.0', (now() AT TIME ZONE 'UTC')::date, 'task_keeper', 1000000000000)`,
            [other],
          );
          try {
            const exhausted = await night("r6");
            assert.equal(exhausted.status, "partial");
            assert.equal(exhausted.halt, "budget");
            assert.equal(exhausted.requests, 0);
          } finally {
            await pool.query(
              "DELETE FROM brain_consolidation_spend WHERE owner_id = $1",
              [other],
            );
          }
          const recovered = await night("r7");
          assert.equal(recovered.status, "succeeded");
          assert.equal(recovered.requests, 1);
          void calendar;
        },
      );

      await t.test(
        "task phases never write pages, typed links or revisions",
        async () => {
          assert.deepEqual(await knowledgeState(ownerId), knowledge);
        },
      );
    } finally {
      if (env.owner === undefined) delete process.env.BRAIN_OWNER_EMAIL;
      else process.env.BRAIN_OWNER_EMAIL = env.owner;
      if (env.embeddings === undefined)
        delete process.env.BRAIN_QUERY_EMBEDDINGS;
      else process.env.BRAIN_QUERY_EMBEDDINGS = env.embeddings;
      if (env.key === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = env.key;
      for (const table of [
        "brain_task_events",
        "brain_tasks",
        "brain_consolidation_records",
        "brain_consolidation_spend",
        "brain_activity",
        "brain_revisions",
        "brain_pages",
        "brain_agent_clients",
        "agent_tokens",
        "brain_agents",
      ])
        await pool.query(`DELETE FROM ${table} WHERE owner_id = $1`, [ownerId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
    }
  },
);

/** An owner, the fake gateway (Jev answers by page title and task text) and a night runner. */
async function nightOwner(
  t: TestContext,
  label: string,
  answer: (title: string, task: { description: string }) => number,
) {
  const pool = getPool();
  const ownerId = randomUUID();
  const email = `task-links-${label}-${ownerId}@example.invalid`;
  const env = {
    BRAIN_OWNER_EMAIL: process.env.BRAIN_OWNER_EMAIL,
    BRAIN_QUERY_EMBEDDINGS: process.env.BRAIN_QUERY_EMBEDDINGS,
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  };
  process.env.BRAIN_OWNER_EMAIL = [env.BRAIN_OWNER_EMAIL, email]
    .filter(Boolean)
    .join(",");
  process.env.BRAIN_QUERY_EMBEDDINGS = "false";
  process.env.AI_GATEWAY_API_KEY = "test-only";
  t.mock.method(
    createRequire(import.meta.url)("next/cache"),
    "revalidateTag",
    () => undefined,
  );
  const calls = { evaluate: 0 };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/v1/embeddings"))
        return Response.json({
          data: (body.input as string[]).map((text, index) => ({
            index,
            embedding: vectorFor(text),
          })),
        });
      if (String(url).endsWith("/v1/evaluate")) {
        calls.evaluate++;
        const request = body as EvaluationRequest & { model: string };
        const state = request.state as {
          task: { description: string };
          pages: Record<string, { title: string }>;
        };
        return Response.json({
          model: request.model,
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [
              key,
              {
                type: "boolean",
                probability: answer(
                  state.pages[key.split("_")[1]].title,
                  state.task,
                ),
              },
            ]),
          ),
          usage: { inputTokens: 1000, outputTokens: 1 },
        });
      }
      throw new Error(`Unexpected network call: ${String(url)}`);
    },
  );
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Links Owner',$2,true,now(),now())`,
    [ownerId, email],
  );
  t.after(async () => {
    for (const [name, value] of Object.entries(env))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    for (const table of [
      "brain_task_events",
      "brain_tasks",
      "brain_consolidation_records",
      "brain_consolidation_spend",
      "brain_activity",
      "brain_revisions",
      "brain_pages",
      "brain_agent_clients",
      "agent_tokens",
      "brain_agents",
    ])
      await pool.query(`DELETE FROM ${table} WHERE owner_id = $1`, [ownerId]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
  });
  const night = (runId: string): Promise<TaskLinksResult> =>
    runTaskLinksPhase({
      ownerId,
      runId,
      runDate: "2026-10-21",
      jobId: randomUUID(),
      attempts: 1,
      scope: "nightly",
    });
  return { ownerId, calls, night };
}

test(
  "task_links: identical tasks keep their own units; a returning unit is applied again; changed tasks lead the queue",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    const MONTHLY = "Verbale della riunione mensile del comitato.";
    const POSTPONED = "Rinviato: il comitato non si riunisce questo mese.";
    const { ownerId, calls, night } = await nightOwner(
      t,
      "units",
      (title, task) => {
        if (task.description === POSTPONED) return 0.1;
        if (title === "Giulia Conti") return 0.9;
        if (title === "Comitato scientifico") return 0.85;
        return 0.2;
      },
    );
    const write = (input: Record<string, unknown>) =>
      brain.write(ownerId, { expectedVersion: 0, ...input });
    await write({
      title: "Giulia Conti",
      type: "person",
      markdown: "Segretaria del comitato; firma il verbale mensile.",
    });
    await write({
      title: "Comitato scientifico",
      type: "note",
      markdown: "Il comitato si riunisce ogni mese e approva il verbale.",
    });
    const owner = await ownerActor(ownerId);
    // Two instances of the same work: same title, description and criteria.
    const content = {
      title: "Preparare il verbale mensile per Giulia Conti",
      description: MONTHLY,
      acceptanceCriteria: ["Verbale firmato"],
    };
    const first = await createTask(owner, content);
    const second = await createTask(owner, content);
    const jevLinks = async (taskId: string) =>
      (
        await getPool().query(
          `SELECT p.title, l.role, l.origin, l.status FROM brain_task_links l
           JOIN brain_pages p ON p.owner_id = l.owner_id AND p.id = l.page_id
           WHERE l.owner_id = $1 AND l.task_id = $2 AND l.origin = 'consolidator'
           ORDER BY p.title, l.role`,
          [ownerId, taskId],
        )
      ).rows;
    const expected = [
      {
        title: "Comitato scientifico",
        role: "context",
        origin: "consolidator",
        status: "suggested",
      },
      {
        title: "Giulia Conti",
        role: "stakeholder",
        origin: "consolidator",
        status: "suggested",
      },
    ];

    await t.test(
      "two tasks with the same text both get Jev links from one request",
      async () => {
        const result = await night("u1");
        assert.equal(result.status, "succeeded", JSON.stringify(result));
        assert.equal(result.tasksConsidered, 2);
        assert.equal(result.unitsReused, 0, "each task has its own unit");
        assert.equal(result.requests, 1, "the evaluation cache answers both");
        assert.equal(calls.evaluate, 1);
        assert.deepEqual(await jevLinks(first.task.id), expected);
        assert.deepEqual(await jevLinks(second.task.id), expected);
        const { rows } = await getPool().query(
          `SELECT count(DISTINCT record_key)::int AS n FROM brain_consolidation_records
           WHERE owner_id = $1 AND record_key LIKE 'task-link:analysis:%'`,
          [ownerId],
        );
        assert.equal(rows[0].n, 2);
      },
    );

    await t.test(
      "an edit retracts the links; reverting it brings the unit back and re-suggests them",
      async () => {
        const edit = async (description: string) => {
          const current = await readTask(owner, { ref: first.task.ref });
          await updateTask(owner, {
            ref: first.task.ref,
            expectedVersion: current.task.version,
            patch: { description },
          });
        };
        await edit(POSTPONED);
        const postponed = await night("u2");
        assert.equal(postponed.status, "succeeded");
        assert.equal(postponed.requests, 1);
        assert.deepEqual(
          (await jevLinks(first.task.id)).map((link) => link.status),
          ["retracted", "retracted"],
        );
        assert.deepEqual(await jevLinks(second.task.id), expected);

        await edit(MONTHLY);
        const reverted = await night("u3");
        assert.equal(reverted.status, "succeeded");
        assert.equal(reverted.requests, 0, "the stored analysis is reused");
        assert.equal(reverted.unitsReused, 2);
        assert.deepEqual(await jevLinks(first.task.id), expected);
        assert.deepEqual(await jevLinks(second.task.id), expected);

        // A rerun of the same Workflow run changes nothing.
        const links = await getPool().query(
          "SELECT task_id, page_id, role, status, updated_at FROM brain_task_links WHERE owner_id = $1 ORDER BY task_id, page_id, role",
          [ownerId],
        );
        const replay = await night("u3");
        assert.equal(replay.requests, 0);
        assert.deepEqual(
          (
            await getPool().query(
              "SELECT task_id, page_id, role, status, updated_at FROM brain_task_links WHERE owner_id = $1 ORDER BY task_id, page_id, role",
              [ownerId],
            )
          ).rows,
          links.rows,
        );
      },
    );

    await t.test(
      "a task whose inputs changed leads the next Jev queue",
      async () => {
        const unchanged = await planTaskLinks(ownerId);
        assert.deepEqual(unchanged.jevTaskIds, [first.task.id, second.task.id]);
        const current = await readTask(owner, { ref: second.task.ref });
        await updateTask(owner, {
          ref: second.task.ref,
          expectedVersion: current.task.version,
          patch: { acceptanceCriteria: ["Verbale firmato e archiviato"] },
        });
        const plan = await planTaskLinks(ownerId);
        assert.deepEqual(plan.jevTaskIds, [second.task.id, first.task.id]);
        assert.equal(plan.remainingTasks, 0);
      },
    );
  },
);
