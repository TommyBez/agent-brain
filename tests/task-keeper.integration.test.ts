import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { after, type TestContext } from "node:test";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";
import { saveConsolidationRecord } from "../lib/maintenance/consolidator/store";
import { runTaskKeeperPhase } from "../lib/maintenance/task-keeper";
import {
  deterministicProposals,
  duplicateUnitId,
  listDuplicatePairs,
  runDeterministicHygiene,
} from "../lib/maintenance/task-keeper/hygiene";
import { TASK_KEEPER_LIMITS } from "../lib/maintenance/task-keeper/policy";
import { prepareKeeperHygiene } from "../lib/maintenance/task-keeper/steps";
import { keeperKeys } from "../lib/maintenance/task-keeper/store";
import type { TaskPhaseContext } from "../lib/maintenance/task-phase";
import {
  ownerActor,
  resolveActor,
  systemActor,
  updateAgent,
} from "../lib/tasks/actors";
import { getMeetingAgenda } from "../lib/tasks/agenda";
import { claimTask, releaseTask } from "../lib/tasks/claims";
import { createMeetingSeries } from "../lib/tasks/meetings";
import {
  approveTask,
  archiveTask,
  cancelTask,
  purgeTask,
} from "../lib/tasks/owner";
import {
  createRecurrence,
  setRecurrencePaused,
  todayInTaskZone,
} from "../lib/tasks/recurrences";
import { createTask } from "../lib/tasks/service";
import { setKeeperExcluded } from "../lib/tasks/settings";
import {
  addTaskLink,
  decideTaskSuggestion,
  listTaskSuggestions,
} from "../lib/tasks/suggestions";

// End to end with fake gateways: Jev and DeepSeek answer from the request
// content, through the real budgeted gateway, records, caches and services.

type Answers = Record<string, { type: "boolean"; probability: number }>;

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
  const source = state.source as
    | { headings: string[]; passages: string[] }
    | undefined;
  if (id === "explicit_commitment")
    return text(source).includes("suggeriti") ? 0.1 : 0.95;
  if (id === "already_done")
    return text(source?.passages).includes("(fatto)") ? 0.95 : 0.05;
  if (
    ["actor_supported", "due_text_supported", "due_date_supported"].includes(id)
  )
    return 0.95;
  if (id.startsWith("duplicate_")) {
    const key = id.slice("duplicate_".length);
    const existing = (state.existing as Record<string, { title: string }>)[key];
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

/** DeepSeek: one item per candidate line "- Who → What (when)". */
function deepSeekContent(
  content: {
    units: { id: string; text: string }[];
    candidatePassageIds: string[];
    projects: { id: string }[];
  },
  retitle: (title: string) => string = (title) => title,
) {
  const items = [];
  for (const id of content.candidatePassageIds) {
    const unit = content.units.find((candidate) => candidate.id === id);
    const match = COMMITMENT.exec(unit?.text.trim() ?? "");
    if (!match) continue;
    const due = match[3] && match[3] !== "fatto" ? match[3] : null;
    const date = /(\d{2})\/(\d{2})\/(\d{4})/.exec(due ?? "");
    items.push({
      passageIds: [id],
      title: retitle(match[2]),
      actorNames: [match[1]],
      dueText: due,
      dueDate: date ? `${date[3]}-${date[2]}-${date[1]}` : null,
      projectRef: content.projects[0]?.id ?? null,
    });
  }
  // Model noise the application must drop.
  items.push({
    passageIds: ["u999"],
    title: "Passaggio inesistente",
    actorNames: [],
    dueText: null,
    dueDate: null,
    projectRef: null,
  });
  return { items };
}

function fakeProviders(
  t: TestContext,
  options: { retitle?: (title: string) => string } = {},
) {
  const bodies: string[] = [];
  const calls = { evaluate: 0, chat: 0 };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      bodies.push(body);
      const request = JSON.parse(body);
      if (String(url).endsWith("/evaluate")) {
        calls.evaluate++;
        const answers: Answers = {};
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
      if (String(url).endsWith("/chat/completions")) {
        calls.chat++;
        const content = JSON.parse(request.messages[1].content);
        return Response.json({
          id: `gen-${calls.chat}`,
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify(
                  deepSeekContent(content, options.retitle),
                ),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.00002 },
        });
      }
      throw new Error(`Unexpected provider call ${String(url)}`);
    },
  );
  return { bodies, calls };
}

async function setupOwner(t: TestContext, label: string) {
  const pool = getPool();
  const ownerId = randomUUID();
  const email = `task-keeper-${label}-${ownerId}@example.invalid`;
  const previous = {
    owner: process.env.BRAIN_OWNER_EMAIL,
    embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
    key: process.env.AI_GATEWAY_API_KEY,
  };
  process.env.BRAIN_OWNER_EMAIL = [previous.owner, email]
    .filter(Boolean)
    .join(",");
  process.env.BRAIN_QUERY_EMBEDDINGS = "false";
  process.env.AI_GATEWAY_API_KEY = "test-only";
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Keeper Owner',$2,true,now(),now())`,
    [ownerId, email],
  );
  t.after(async () => {
    for (const [name, value] of [
      ["BRAIN_OWNER_EMAIL", previous.owner],
      ["BRAIN_QUERY_EMBEDDINGS", previous.embeddings],
      ["AI_GATEWAY_API_KEY", previous.key],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    for (const table of [
      "brain_task_suggestions",
      "brain_task_parties",
      "brain_task_links",
      "brain_task_events",
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

function context(ownerId: string, runDate = todayInTaskZone()) {
  return (): TaskPhaseContext => ({
    ownerId,
    runId: randomUUID(),
    runDate,
    jobId: randomUUID(),
    attempts: 1,
    scope: "tasks",
  });
}

async function knowledgeState(ownerId: string) {
  const { rows } = await getPool().query(
    `SELECT (SELECT json_agg(json_build_array(id, version) ORDER BY id) FROM brain_pages WHERE owner_id = $1) AS versions,
       (SELECT count(*)::int FROM brain_revisions WHERE owner_id = $1) AS revisions,
       (SELECT count(*)::int FROM brain_links WHERE owner_id = $1) AS links`,
    [ownerId],
  );
  return rows[0];
}

async function tasksOf(ownerId: string) {
  const { rows } = await getPool().query(
    `SELECT t.id, t.number, t.title, t.status, t.origin, t.batch_id, t.extraction_fingerprint,
       t.due_kind, to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.due_text, t.project_page_id,
       t.description, t.recurrence_id, to_char(t.occurrence_on, 'YYYY-MM-DD') AS occurrence_on,
       a.system_key AS creator
     FROM brain_tasks t JOIN brain_agents a ON a.owner_id = t.owner_id AND a.id = t.created_by_agent_id
     WHERE t.owner_id = $1 ORDER BY t.number`,
    [ownerId],
  );
  return rows;
}

after(async () => {
  if (process.env.RUN_DB_TESTS === "1") await getPool().end();
});

const MINUTE = `# Verbale 15/10/2026

Presenti: Mario Rossi, Giulia Bianchi, Tommaso.

## Azioni

- Mario → Preparare il report clinico (entro 30/10/2026)
- Giulia Bianchi → Contattare il fornitore dei kit (alla prossima riunione)
- Tommaso → Decidere come prosegue il monitoraggio (entro 16/10/2026)
- Tutti → Rivedere la bozza del protocollo
- Luca → Inviare il preventivo (fatto)

## Ipotesi

- Potremmo valutare un nuovo fornitore.

## Prossimi passi suggeriti dall'assistente

- Claude → Approfondire la letteratura
`;

test(
  "task keeper: meeting notes become cited triage tasks; reruns, rejections, sources, hygiene, recurrences and agenda",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    const ownerId = await setupOwner(t, "main");
    const providers = fakeProviders(t);
    const run = context(ownerId);
    const owner = await ownerActor(ownerId);
    const keeper = await systemActor(ownerId, "task_keeper");

    const write = (input: Record<string, unknown>) =>
      brain.write(ownerId, { expectedVersion: 0, ...input });
    const mario = await write({
      title: "Mario Rossi",
      type: "person",
      markdown: "Responsabile clinico.",
    });
    const tommaso = await write({
      title: "Tommaso Carnemolla",
      type: "person",
      markdown: "Proprietario del brain.",
    });
    await updateAgent(ownerId, owner.agentId, { personPageId: tommaso.id });
    const project = await write({
      title: "Report studi clinici",
      type: "project",
      markdown: "Monitoraggio degli studi clinici per il cliente.",
    });
    let minute = await write({
      title: "Verbale 15/10/2026",
      type: "note",
      markdown: MINUTE,
      links: [
        { targetRef: mario.id, type: "relates_to" },
        { targetRef: tommaso.id, type: "relates_to" },
        { targetRef: project.id, type: "relates_to" },
      ],
    });
    const confidential = await write({
      title: "Riservato AstraZeneca",
      type: "note",
      markdown: "- Mario → Firmare il contratto riservato (entro 31/10/2026)\n",
    });
    await setKeeperExcluded(owner, confidential.id, true);
    await write({
      title: "Note sparse",
      type: "note",
      markdown: "Il cliente preferisce report in formato PDF.",
    });

    await t.test(
      "a meeting note produces cited triage tasks with parties",
      async () => {
        const before = await knowledgeState(ownerId);
        const result = await runTaskKeeperPhase(run());
        assert.equal(result.status, "succeeded", JSON.stringify(result));
        assert.equal(result.halt, null);
        assert.equal(
          result.pagesConsidered,
          5,
          "all pages minus the excluded one",
        );
        assert.equal(result.unitsReused, 0);
        assert.equal(result.created, 4);
        assert.equal(result.alreadyDone, 1);
        assert.equal(result.notCommitments, 1);
        assert.ok(result.requests > 0);
        assert.ok(result.spendNano > 0);
        assert.deepEqual(
          await knowledgeState(ownerId),
          before,
          "no page writes",
        );
        assert.ok(
          providers.bodies.every(
            (body) => !body.includes("contratto riservato"),
          ),
          "excluded pages never reach a model",
        );

        const tasks = await tasksOf(ownerId);
        assert.deepEqual(
          tasks.map((task) => task.title),
          [
            "Preparare il report clinico",
            "Contattare il fornitore dei kit",
            "Decidere come prosegue il monitoraggio",
            "Rivedere la bozza del protocollo",
          ],
        );
        for (const task of tasks) {
          assert.equal(task.status, "triage");
          assert.equal(task.origin, "extracted");
          assert.equal(task.creator, "task_keeper");
          assert.equal(task.batch_id, `${minute.id}@${minute.version}`);
          assert.match(task.extraction_fingerprint, /^[a-f0-9]{64}$/);
          assert.equal(task.project_page_id, project.id);
          assert.match(task.description, new RegExp(`/pages/${minute.id}\\)`));
        }
        const [report, supplier, decision, review] = tasks;
        assert.deepEqual(
          [report.due_kind, report.due_on, report.due_text],
          ["date", "2026-10-30", "entro 30/10/2026"],
        );
        assert.deepEqual(
          [supplier.due_kind, supplier.due_text],
          ["event", "alla prossima riunione"],
        );
        assert.equal(review.due_kind, "unset");

        const { rows: links } = await getPool().query(
          `SELECT task_id, page_id, role, origin, status, evidence FROM brain_task_links
         WHERE owner_id = $1 AND role = 'source' ORDER BY task_id`,
          [ownerId],
        );
        assert.equal(links.length, 4);
        for (const link of links) {
          assert.equal(link.page_id, minute.id);
          assert.deepEqual(
            [link.role, link.origin, link.status],
            ["source", "task_keeper", "active"],
          );
          assert.equal(link.evidence.pageVersion, minute.version);
          assert.equal(link.evidence.basis, "extraction");
          const task = tasks.find((candidate) => candidate.id === link.task_id);
          assert.ok(
            MINUTE.slice(
              link.evidence.startOffset,
              link.evidence.endOffset,
            ).includes(task.title),
            "offsets address the cited passage",
          );
        }

        const { rows: parties } = await getPool().query(
          `SELECT task_id, role, kind, person_page_id, group_label, agent_id FROM brain_task_parties
         WHERE owner_id = $1`,
          [ownerId],
        );
        const partyOf = (taskId: string) =>
          parties.filter((party) => party.task_id === taskId);
        assert.deepEqual(
          partyOf(report.id).map((party) => [
            party.role,
            party.kind,
            party.person_page_id,
          ]),
          [["lead", "person", mario.id]],
          "a first name resolves to the linked person page",
        );
        assert.deepEqual(
          partyOf(supplier.id).map((party) => [party.kind, party.group_label]),
          [["group", "Giulia Bianchi"]],
          "an unknown person stays text, never an invented page",
        );
        assert.deepEqual(
          partyOf(decision.id).map((party) => [party.kind, party.agent_id]),
          [["owner", owner.agentId]],
        );
        assert.deepEqual(
          partyOf(review.id).map((party) => [party.kind, party.group_label]),
          [["group", "Tutti"]],
        );
        const { rows: events } = await getPool().query(
          `SELECT action, actor_agent_id, payload FROM brain_task_events WHERE owner_id = $1 AND action = 'created'`,
          [ownerId],
        );
        assert.ok(
          events.every((event) => event.actor_agent_id === keeper.agentId),
        );
        const { rows: spend } = await getPool().query(
          "SELECT DISTINCT purpose FROM brain_consolidation_spend WHERE owner_id = $1",
          [ownerId],
        );
        assert.deepEqual(spend, [{ purpose: "task_keeper" }]);
      },
    );

    await t.test("a second run produces nothing and pays nothing", async () => {
      const calls = { ...providers.calls };
      const result = await runTaskKeeperPhase(run());
      assert.equal(result.status, "succeeded");
      assert.equal(result.created, 0);
      assert.equal(result.pagesConsidered, 0);
      assert.equal(result.unitsReused, 5);
      assert.equal(result.requests, 0);
      assert.deepEqual(providers.calls, calls);
      assert.equal((await tasksOf(ownerId)).length, 4);
    });

    await t.test(
      "rejections never return; another source becomes new_source",
      async () => {
        const tasks = await tasksOf(ownerId);
        const review = tasks.find((task) => task.title.startsWith("Rivedere"));
        await cancelTask(owner, `T-${review.number}`, { note: "Non serve" });
        minute = await brain.write(ownerId, {
          id: minute.id,
          expectedVersion: minute.version,
          title: minute.title,
          type: "note",
          markdown: `${MINUTE}\n## Aggiunte\n\n- Mario → Aggiornare il budget\n`,
          links: [
            { targetRef: mario.id, type: "relates_to" },
            { targetRef: tommaso.id, type: "relates_to" },
            { targetRef: project.id, type: "relates_to" },
          ],
        });
        const followUp = await write({
          title: "Verbale 20/10/2026",
          type: "note",
          markdown:
            "# Verbale 20/10/2026\n\n- Mario → Preparare il report clinico (entro 06/11/2026)\n- Giulia → Rivedere la bozza del protocollo\n",
          links: [{ targetRef: project.id, type: "relates_to" }],
        });
        const before = await knowledgeState(ownerId);
        const result = await runTaskKeeperPhase(run());
        assert.equal(result.status, "succeeded", JSON.stringify(result));
        assert.equal(result.created, 1, "only the new commitment");
        assert.equal(result.newSources, 1);
        assert.equal(
          result.rejected,
          2,
          "same extraction and a duplicate of it",
        );
        assert.equal(result.existing, 3);
        assert.deepEqual(await knowledgeState(ownerId), before);
        const after = await tasksOf(ownerId);
        assert.equal(after.length, 5);
        assert.equal(after[4].title, "Aggiornare il budget");
        assert.equal(after[4].batch_id, `${minute.id}@${minute.version}`);

        const report = after[0];
        const [suggestion] = await listTaskSuggestions(ownerId, {
          taskRef: `T-${report.number}`,
        });
        assert.equal(suggestion.kind, "new_source");
        assert.equal(suggestion.citations[0].pageId, followUp.id);
        assert.match(suggestion.citations[0].excerpt, /entro 06\/11\/2026/);
        assert.equal(suggestion.payload.action, "link");
        assert.equal(suggestion.payload.role, "source");
        assert.deepEqual(suggestion.payload.due, {
          kind: "date",
          on: "2026-11-06",
          text: "entro 06/11/2026",
          sourceExcerpt:
            "- Mario → Preparare il report clinico (entro 06/11/2026)",
        });
        const { rows: reportLinks } = await getPool().query(
          "SELECT page_id FROM brain_task_links WHERE owner_id = $1 AND task_id = $2 AND role = 'source'",
          [ownerId, report.id],
        );
        assert.deepEqual(
          reportLinks,
          [{ page_id: minute.id }],
          "never applied",
        );

        const again = await runTaskKeeperPhase(run());
        assert.equal(again.created + again.newSources + again.requests, 0);
      },
    );

    await t.test(
      "the agenda lists due, overdue and recently closed work",
      async () => {
        const series = await createMeetingSeries(
          owner,
          {
            title: "Riunione JSB",
            projectRef: project.id,
            rrule: "FREQ=WEEKLY;BYDAY=TU",
            startsOn: "2026-10-06",
            time: "09:00",
          },
          "2026-10-21",
        );
        assert.equal(series.nextMeeting, "2026-10-27");
        const agenda = await getMeetingAgenda(ownerId, series.id, "2026-10-21");
        assert.ok(agenda);
        assert.equal(agenda.meeting, "2026-10-27");
        assert.equal(agenda.previousMeeting, "2026-10-20");
        assert.deepEqual(
          agenda.dueAtMeeting.map((task) => task.title.value),
          ["Contattare il fornitore dei kit"],
        );
        assert.deepEqual(agenda.dueAtMeeting[0].leads, ["Giulia Bianchi"]);
        assert.deepEqual(
          agenda.overdue.map((task) => task.title.value),
          ["Decidere come prosegue il monitoraggio"],
        );
        assert.deepEqual(
          agenda.closedSinceLast.map((task) => [task.title.value, task.status]),
          [["Rivedere la bozza del protocollo", "canceled"]],
        );
      },
    );

    await t.test(
      "hygiene suggestions are deduplicated, capped and never return once dismissed",
      async () => {
        const pool = getPool();
        const tasks = await tasksOf(ownerId);
        const supplier = tasks.find((task) =>
          task.title.startsWith("Contattare"),
        );
        const oldDecision = await write({
          title: "Decisione fornitori 2025",
          type: "decision",
          markdown: "Usiamo un solo fornitore.",
        });
        const otherDecision = await write({
          title: "Decisione kit 2025",
          type: "decision",
          markdown: "Kit standard.",
        });
        for (const decision of [oldDecision, otherDecision])
          await addTaskLink(owner, `T-${supplier.number}`, {
            pageRef: decision.id,
            role: "decision",
          });
        await write({
          title: "Decisione fornitori 2026",
          type: "decision",
          markdown: "Due fornitori in parallelo.",
          links: [
            { targetRef: oldDecision.id, type: "supersedes" },
            { targetRef: otherDecision.id, type: "supersedes" },
          ],
        });
        // Overdue for five days, no events since; eight days in triage.
        await pool.query(
          `UPDATE brain_tasks SET due_kind = 'date', due_text = NULL, due_on = current_date - 5,
           created_at = now() - interval '8 days' WHERE owner_id = $1 AND id = $2`,
          [ownerId, supplier.id],
        );
        await pool.query(
          "UPDATE brain_task_events SET created_at = now() - interval '9 days' WHERE owner_id = $1 AND task_id = $2",
          [ownerId, supplier.id],
        );
        // A claim whose lease expired without a report.
        const worker = await resolveActor(ownerId, {
          ownerId,
          scopes: ["brain:read", "brain:write"],
          kind: "oauth",
          clientId: `keeper-test-${ownerId.slice(0, 8)}`,
        });
        const claimed = await createTask(owner, {
          title: "Pulire i dati del trial",
        });
        await claimTask(worker, { ref: claimed.task.ref });
        await pool.query(
          "UPDATE brain_tasks SET lease_expires_at = now() - interval '1 hour' WHERE owner_id = $1 AND id = $2",
          [ownerId, claimed.task.id],
        );

        // Two open tasks for the same work.
        const kickoff = await createTask(owner, {
          title: "Organizzare il kick-off con il cliente",
        });
        const kickoffAgain = await createTask(owner, {
          title: "Organizzare il kick-off con il cliente",
        });

        const before = await knowledgeState(ownerId);
        const first = await runTaskKeeperPhase(run());
        assert.deepEqual(await knowledgeState(ownerId), before);
        const [duplicate] = await listTaskSuggestions(ownerId, {
          taskRef: kickoffAgain.task.ref,
        });
        assert.equal(duplicate?.kind, "duplicate");
        assert.equal(duplicate.relatedRef, kickoff.task.ref);
        assert.equal(duplicate.payload.action, "merge");
        const open = async (ref: string) =>
          (await listTaskSuggestions(ownerId, { taskRef: ref })).filter(
            (suggestion) => suggestion.status === "open",
          );
        const supplierOpen = await open(`T-${supplier.number}`);
        assert.equal(supplierOpen.length, 3, "at most three open per task");
        assert.ok(
          supplierOpen.every((suggestion) =>
            [
              "overdue_no_outcome",
              "triage_aging",
              "decision_superseded",
            ].includes(suggestion.kind),
          ),
        );
        assert.deepEqual(
          (await open(claimed.task.ref)).map((suggestion) => suggestion.kind),
          ["stale_claim"],
        );
        assert.ok(first.suggestions >= 5);

        const second = await runTaskKeeperPhase(run());
        assert.equal(second.suggestions, 0, "dedupe keys hold");
        assert.equal((await open(`T-${supplier.number}`)).length, 3);

        const overdue = supplierOpen.find(
          (suggestion) => suggestion.kind === "overdue_no_outcome",
        );
        assert.ok(overdue);
        await decideTaskSuggestion(owner, {
          id: overdue.id,
          decision: "dismissed",
        });
        await runTaskKeeperPhase(run());
        const { rows } = await pool.query(
          "SELECT status FROM brain_task_suggestions WHERE owner_id = $1 AND id = $2",
          [ownerId, overdue.id],
        );
        assert.equal(
          rows[0].status,
          "dismissed",
          "a dismissed suggestion never returns",
        );
        const reopened = await open(`T-${supplier.number}`);
        assert.equal(
          reopened.length,
          3,
          "the freed slot takes the queued proposal",
        );
        assert.ok(
          reopened.every(
            (suggestion) => suggestion.kind !== "overdue_no_outcome",
          ),
        );

        await approveTask(owner, `T-${supplier.number}`);
        await runTaskKeeperPhase(run());
        const { rows: aging } = await pool.query(
          `SELECT status FROM brain_task_suggestions WHERE owner_id = $1 AND kind = 'triage_aging'`,
          [ownerId],
        );
        assert.deepEqual(
          aging,
          [{ status: "expired" }],
          "a cleared condition expires",
        );
      },
    );

    await t.test(
      "a changed linked page saying the work is done suggests may_be_done",
      async () => {
        const report = (await tasksOf(ownerId))[0];
        minute = await brain.write(ownerId, {
          id: minute.id,
          expectedVersion: minute.version,
          title: minute.title,
          type: "note",
          markdown: `${MINUTE}\n## Aggiunte\n\n- Mario → Aggiornare il budget\n\nFatto: Preparare il report clinico\n`,
          links: [
            { targetRef: mario.id, type: "relates_to" },
            { targetRef: tommaso.id, type: "relates_to" },
            { targetRef: project.id, type: "relates_to" },
          ],
        });
        const result = await runTaskKeeperPhase(run());
        assert.equal(result.created, 0);
        const suggestions = await listTaskSuggestions(ownerId, {
          taskRef: `T-${report.number}`,
        });
        const done = suggestions.find(
          (suggestion) => suggestion.kind === "may_be_done",
        );
        assert.ok(done, JSON.stringify(suggestions));
        assert.ok((done.confidence ?? 0) >= 0.85);
        assert.equal(done.citations[0].pageId, minute.id);
        assert.equal(done.payload.action, "close");
        const { rows } = await getPool().query(
          "SELECT status FROM brain_tasks WHERE owner_id = $1 AND id = $2",
          [ownerId, report.id],
        );
        assert.equal(rows[0].status, "triage", "never auto-applied");
      },
    );

    await t.test(
      "recurrences: one ready instance per occurrence, pause respected",
      async () => {
        const today = todayInTaskZone();
        const series = await createRecurrence(
          owner,
          {
            title: "Inviare il report settimanale",
            projectRef: project.id,
            rrule: "FREQ=DAILY",
            startsOn: today,
          },
          today,
        );
        assert.equal(series.nextOn, today);
        const first = await runTaskKeeperPhase(run());
        assert.equal(first.occurrences, 1);
        const again = await runTaskKeeperPhase(run());
        assert.equal(again.occurrences, 0, "one instance per occurrence");
        const instances = (await tasksOf(ownerId)).filter(
          (task) => task.recurrence_id === series.id,
        );
        assert.equal(instances.length, 1);
        assert.deepEqual(
          [
            instances[0].status,
            instances[0].origin,
            instances[0].occurrence_on,
            instances[0].due_on,
            instances[0].creator,
          ],
          ["ready", "recurrence", today, today, "task_keeper"],
        );
        await setRecurrencePaused(owner, series.id, true, today);
        const tomorrow = new Date(`${today}T12:00:00Z`);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const paused = await runTaskKeeperPhase(
          context(ownerId, tomorrow.toISOString().slice(0, 10))(),
        );
        assert.equal(paused.occurrences, 0);
        // Resuming two days later skips the paused occurrences.
        const later = new Date(`${today}T12:00:00Z`);
        later.setUTCDate(later.getUTCDate() + 2);
        const resumeDay = later.toISOString().slice(0, 10);
        const resumed = await setRecurrencePaused(
          owner,
          series.id,
          false,
          resumeDay,
        );
        assert.equal(resumed.nextOn, resumeDay);
        const afterResume = await runTaskKeeperPhase(
          context(ownerId, resumeDay)(),
        );
        assert.equal(afterResume.occurrences, 1);
        const dates = (await tasksOf(ownerId))
          .filter((task) => task.recurrence_id === series.id)
          .map((task) => task.occurrence_on);
        assert.deepEqual(dates, [today, resumeDay]);
      },
    );
  },
);

test(
  "task keeper: at most 50 new tasks per run, the rest on the next run",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    const ownerId = await setupOwner(t, "cap");
    fakeProviders(t);
    const run = context(ownerId);
    const words = ["alfa", "bravo", "charlie", "delta", "echo", "fox"];
    for (let page = 0; page < 3; page++) {
      const lines = Array.from(
        { length: TASK_KEEPER_LIMITS.itemsPerPage },
        (_, index) =>
          `- Squadra ${page} → Attività ${words[page]} ${String.fromCharCode(97 + index)}${index} ${words[(index % 5) + 1]}`,
      );
      await brain.write(ownerId, {
        expectedVersion: 0,
        title: `Piano ${page}`,
        type: "note",
        markdown: `# Piano ${page}\n\n${lines.join("\n")}\n`,
      });
    }
    const first = await runTaskKeeperPhase(run());
    assert.equal(first.created, TASK_KEEPER_LIMITS.newTasksPerRun);
    assert.equal(first.status, "partial");
    assert.equal(first.halt, "limit");
    assert.ok(first.remainingPages >= 1);
    const second = await runTaskKeeperPhase(run());
    assert.equal(second.created, 60 - TASK_KEEPER_LIMITS.newTasksPerRun);
    assert.equal(second.status, "succeeded");
    assert.equal(second.remainingPages, 0);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS count, count(DISTINCT extraction_fingerprint)::int AS distinct FROM brain_tasks WHERE owner_id = $1",
      [ownerId],
    );
    assert.deepEqual(rows[0], { count: 60, distinct: 60 });
  },
);

test(
  "task keeper: provider failures end the pass partial, never failed",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 120_000 },
  async (t) => {
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    const ownerId = await setupOwner(t, "errors");
    for (let page = 0; page < 4; page++)
      await brain.write(ownerId, {
        expectedVersion: 0,
        title: `Nota ${page}`,
        type: "note",
        markdown: `- Squadra → Compito ${page}\n`,
      });
    let status = 503;
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () => new Response("{}", { status }),
    );
    const run = context(ownerId);
    const unavailable = await runTaskKeeperPhase(run());
    assert.equal(unavailable.status, "partial");
    assert.equal(unavailable.halt, "provider", "three failures in a row");
    assert.equal(unavailable.failedPages, TASK_KEEPER_LIMITS.providerFailures);
    assert.equal(unavailable.remainingPages, 4);
    assert.equal(fetch.mock.callCount(), TASK_KEEPER_LIMITS.providerFailures);

    status = 402;
    const unpaid = await runTaskKeeperPhase(run());
    assert.equal(unpaid.status, "partial");
    assert.equal(unpaid.halt, "provider");
    assert.equal(
      fetch.mock.callCount(),
      TASK_KEEPER_LIMITS.providerFailures + 1,
    );
    assert.equal(unpaid.created, 0);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS count FROM brain_tasks WHERE owner_id = $1",
      [ownerId],
    );
    assert.equal(rows[0].count, 0);
  },
);

test(
  "task keeper: a rejected extraction never returns after rewording, archive or purge",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    const ownerId = await setupOwner(t, "rejections");
    const retitled = new Map<string, string>();
    fakeProviders(t, { retitle: (title) => retitled.get(title) ?? title });
    const run = context(ownerId);
    const owner = await ownerActor(ownerId);
    const markdown = (due: string, extra = "") =>
      `# Verbale 01/10/2026\n\n- Mario → Preparare il report clinico (entro ${due})\n- Giulia → Inviare il preventivo al cliente\n${extra}`;
    let minute = await brain.write(ownerId, {
      expectedVersion: 0,
      title: "Verbale 01/10/2026",
      type: "note",
      markdown: markdown("30/10/2026"),
    });
    const first = await runTaskKeeperPhase(run());
    assert.equal(first.created, 2, JSON.stringify(first));
    const [report, quote] = await tasksOf(ownerId);
    assert.equal(quote.title, "Inviare il preventivo al cliente");
    // Canceled then archived; purged as confidential.
    await cancelTask(owner, `T-${report.number}`, { note: "Non serve" });
    await archiveTask(owner, `T-${report.number}`, true);
    await purgeTask(owner, `T-${quote.number}`);

    // The page changes: the report's deadline moves (a new passage text),
    // the model words the purged commitment differently, a new line arrives.
    retitled.set(
      "Inviare il preventivo al cliente",
      "Mandare al cliente il preventivo",
    );
    minute = await brain.write(ownerId, {
      id: minute.id,
      expectedVersion: minute.version,
      title: minute.title,
      type: "note",
      markdown: markdown(
        "06/11/2026",
        "- Luca → Prenotare la sala per il comitato\n",
      ),
    });
    const second = await runTaskKeeperPhase(run());
    assert.equal(second.status, "succeeded", JSON.stringify(second));
    assert.equal(second.created, 1, "only the new commitment");
    assert.equal(second.rejected, 2, "the archived and the purged rejection");
    const after = await tasksOf(ownerId);
    assert.deepEqual(
      after.map((task) => task.title),
      ["Preparare il report clinico", "Prenotare la sala per il comitato"],
    );
    assert.equal(after[0].status, "canceled");
    const again = await runTaskKeeperPhase(run());
    assert.equal(again.created + again.requests, 0);
  },
);

test(
  "task keeper: deterministic hygiene ignores machine bookkeeping and opens one suggestion per episode",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 120_000 },
  async (t) => {
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    const ownerId = await setupOwner(t, "episodes");
    const pool = getPool();
    const owner = await ownerActor(ownerId);
    const keeper = await systemActor(ownerId, "task_keeper");
    const conciliator = await systemActor(ownerId, "consolidator");
    const hygiene = () => runDeterministicHygiene(ownerId, keeper.agentId);
    const suggestions = async (taskId: string, kind: string) =>
      (
        await pool.query(
          `SELECT dedupe_key, status FROM brain_task_suggestions
           WHERE owner_id = $1 AND task_id = $2 AND kind = $3 ORDER BY created_at, dedupe_key`,
          [ownerId, taskId, kind],
        )
      ).rows;

    await t.test(
      "link upkeep and keeper events after the due date are not an outcome",
      async () => {
        const late = await createTask(owner, {
          title: "Rinnovare il contratto di manutenzione",
        });
        await pool.query(
          "UPDATE brain_tasks SET due_kind = 'date', due_on = current_date - 5 WHERE owner_id = $1 AND id = $2",
          [ownerId, late.task.id],
        );
        await pool.query(
          "UPDATE brain_task_events SET created_at = now() - interval '9 days' WHERE owner_id = $1 AND task_id = $2",
          [ownerId, late.task.id],
        );
        const event = (agentId: string, action: string) =>
          pool.query(
            `INSERT INTO brain_task_events (owner_id, task_id, actor_agent_id, action, payload)
             VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
            [ownerId, late.task.id, agentId, action],
          );
        await event(conciliator.agentId, "links_changed");
        await event(keeper.agentId, "note");
        await event(owner.agentId, "links_changed");
        const overdue = async () =>
          (await deterministicProposals(ownerId)).filter(
            (proposal) =>
              proposal.taskId === late.task.id &&
              proposal.kind === "overdue_no_outcome",
          );
        assert.equal((await overdue()).length, 1);
        await event(owner.agentId, "edited");
        assert.equal((await overdue()).length, 0, "an owner edit is activity");
      },
    );

    await t.test(
      "a lease that expires again after a report opens a new stale_claim",
      async () => {
        const worker = await resolveActor(ownerId, {
          ownerId,
          scopes: ["brain:read", "brain:write"],
          kind: "oauth",
          clientId: `episodes-${ownerId.slice(0, 8)}`,
        });
        const claimed = await createTask(owner, {
          title: "Pulire i dati del trial",
        });
        await claimTask(worker, { ref: claimed.task.ref });
        const lease = (offset: string) =>
          pool.query(
            `UPDATE brain_tasks SET lease_expires_at = now() + $3::interval WHERE owner_id = $1 AND id = $2`,
            [ownerId, claimed.task.id, offset],
          );
        await lease("-1 hour");
        await hygiene();
        let rows = await suggestions(claimed.task.id, "stale_claim");
        assert.deepEqual(
          rows.map((row) => row.status),
          ["open"],
        );
        // A report renews the lease: the condition clears.
        await lease("1 hour");
        await hygiene();
        rows = await suggestions(claimed.task.id, "stale_claim");
        assert.deepEqual(
          rows.map((row) => row.status),
          ["expired"],
        );
        // The renewed lease expires too: a new episode, a new suggestion.
        await lease("-10 minutes");
        await hygiene();
        rows = await suggestions(claimed.task.id, "stale_claim");
        assert.deepEqual(rows.map((row) => row.status).sort(), [
          "expired",
          "open",
        ]);
        await hygiene();
        assert.equal(
          (await suggestions(claimed.task.id, "stale_claim")).length,
          2,
          "the episode key holds",
        );
      },
    );

    await t.test(
      "a task back in triage ages from its return, under a new key",
      async () => {
        const agent = await resolveActor(ownerId, {
          ownerId,
          scopes: ["brain:read", "brain:write"],
          kind: "oauth",
          clientId: `episodes-agent-${ownerId.slice(0, 8)}`,
        });
        const created = await createTask(agent, {
          title: "Raccogliere i consensi firmati",
          origin: "owner_request",
          ownerQuote: "tieni traccia dei consensi",
          idempotencyKey: `episodes-${ownerId}`,
        });
        assert.equal(created.task.status, "triage");
        const id = created.task.id;
        await pool.query(
          "UPDATE brain_task_events SET created_at = now() - interval '20 days' WHERE owner_id = $1 AND task_id = $2",
          [ownerId, id],
        );
        await pool.query(
          "UPDATE brain_tasks SET created_at = now() - interval '20 days' WHERE owner_id = $1 AND id = $2",
          [ownerId, id],
        );
        await hygiene();
        assert.deepEqual(
          (await suggestions(id, "triage_aging")).map((row) => row.status),
          ["open"],
        );
        // The creator works on it and hands it back to triage.
        const claim = await claimTask(agent, { ref: created.task.ref });
        await hygiene();
        assert.deepEqual(
          (await suggestions(id, "triage_aging")).map((row) => row.status),
          ["expired"],
        );
        await releaseTask(agent, {
          ref: created.task.ref,
          leaseId: claim.leaseId,
          reason: "handoff",
          note: "Serve il proprietario",
        });
        await hygiene();
        assert.equal(
          (await suggestions(id, "triage_aging")).length,
          1,
          "fresh in triage again",
        );
        await pool.query(
          `UPDATE brain_task_events SET created_at = now() - interval '8 days'
           WHERE owner_id = $1 AND task_id = $2 AND action = 'released'`,
          [ownerId, id],
        );
        await hygiene();
        assert.deepEqual(
          (await suggestions(id, "triage_aging"))
            .map((row) => row.status)
            .sort(),
          ["expired", "open"],
        );
      },
    );
  },
);

test(
  "task keeper: identical tasks get their own hygiene; judged pairs never crowd out the rest",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    const ownerId = await setupOwner(t, "units");
    fakeProviders(t);
    const run = context(ownerId);
    const owner = await ownerActor(ownerId);

    await t.test(
      "a later instance with the same text and pages is evaluated",
      async () => {
        const report = await brain.write(ownerId, {
          expectedVersion: 0,
          title: "Report settimanale",
          type: "note",
          markdown: "Il report settimanale va al cliente il venerdì.",
        });
        const content = {
          title: "Inviare il report settimanale",
          description: `Modello in /pages/${report.id}`,
        };
        const first = await createTask(owner, content);
        await runTaskKeeperPhase(run());
        const plan = await prepareKeeperHygiene(ownerId);
        assert.deepEqual(plan.taskIds, [], "the first instance is judged");
        const second = await createTask(owner, content);
        const next = await prepareKeeperHygiene(ownerId);
        assert.deepEqual(next.taskIds, [second.task.id]);
        void first;
      },
    );

    await t.test(
      "duplicate pairs judged earlier are skipped before the per-run cap",
      async () => {
        for (let index = 0; index < 15; index++)
          await createTask(owner, {
            title: `Organizzare il kick-off con il cliente ${String.fromCharCode(97 + index)}`,
          });
        const pairs = [];
        for (let after = null as { a: number; b: number } | null; ; ) {
          const page = await listDuplicatePairs(ownerId, { after });
          pairs.push(...page);
          if (page.length < 100) break;
          const last = page[page.length - 1];
          after = { a: last.a.number, b: last.b.number };
        }
        const kickoff = pairs.filter(
          (pair) =>
            pair.a.title.startsWith("Organizzare") &&
            pair.b.title.startsWith("Organizzare"),
        );
        assert.equal(kickoff.length, 105);
        // The first 100 pairs were judged on earlier nights.
        for (const pair of pairs.slice(0, 100))
          await saveConsolidationRecord(
            ownerId,
            "earlier",
            keeperKeys.duplicate(duplicateUnitId(pair)),
            { a: pair.a.id, b: pair.b.id, probability: 0.05 },
          );
        const plan = await prepareKeeperHygiene(ownerId);
        assert.deepEqual(
          plan.duplicatePairs,
          pairs.slice(100, 120).map((pair) => ({ a: pair.a.id, b: pair.b.id })),
        );
      },
    );
  },
);
