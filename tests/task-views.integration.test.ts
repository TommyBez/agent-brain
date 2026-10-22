import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { GET as changes } from "../app/api/tasks/changes/route";
import { boardMove } from "../components/tasks/transitions";
import { createAgentToken } from "../lib/agent-tokens";
import type { Principal } from "../lib/auth-principal";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";
import {
  type Actor,
  ownerActor,
  resolveActor,
  systemActor,
  updateAgent,
} from "../lib/tasks/actors";
import { claimTask, completeTask, reportTask } from "../lib/tasks/claims";
import { addTaskDependency } from "../lib/tasks/dependencies";
import { latestTaskEventId } from "../lib/tasks/events";
import { blockTask, closeTask, holdTask } from "../lib/tasks/owner";
import { addTaskParty } from "../lib/tasks/parties";
import { createTask } from "../lib/tasks/service";
import { saveTaskView, setKeeperExcluded } from "../lib/tasks/settings";
import { taskBatchId } from "../lib/tasks/types";
import {
  queryKeeperExclusions,
  queryNeedsYou,
  queryNeedsYouCount,
  queryPersonTasks,
  queryProjectTasks,
  querySuggestion,
  queryTaskBoard,
  queryTaskCalendar,
  queryTaskDetail,
  queryTaskFormChoices,
  queryTaskOverview,
  queryTaskState,
  queryTaskTable,
  queryTaskWatermark,
} from "../lib/workspace/task-queries";
import {
  DEFAULT_TASK_LIST_FILTERS,
  type TaskListFilters,
} from "../lib/workspace/task-urls";

const filters = (changes: Partial<TaskListFilters>): TaskListFilters => ({
  ...DEFAULT_TASK_LIST_FILTERS,
  ...changes,
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test(
  "task views: Needs you, table filters, detail, calendar, board, page sections and the changes poll",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `task-views-${ownerId}@example.invalid`;
    const suffix = ownerId.slice(0, 8);
    const original = {
      owner: process.env.BRAIN_OWNER_EMAIL,
      embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
      tasks: process.env.TASKS_ENABLED,
    };
    process.env.BRAIN_OWNER_EMAIL = [original.owner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    process.env.TASKS_ENABLED = "1";
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Views Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    const oauth = (name: string): Principal => ({
      ownerId,
      scopes: ["brain:read", "brain:write"],
      kind: "oauth",
      clientId: `${name}-${suffix}`,
    });
    const owner = await ownerActor(ownerId);
    const claude = await resolveActor(ownerId, oauth("claude-code"));
    const codex = await resolveActor(ownerId, oauth("codex"));
    const keeper = await systemActor(ownerId, "task_keeper");
    let seed = 0;
    const page = (
      title: string,
      type: "project" | "note" | "person",
      markdown = `${title} body.`,
    ) =>
      brain.write(
        ownerId,
        { title: `${title} ${suffix}`, type, markdown, expectedVersion: 0 },
        { actorAgentId: owner.agentId },
      );
    const ownerTask = async (fields: Record<string, unknown> = {}) =>
      (await createTask(owner, { title: `Owner task ${++seed}`, ...fields }))
        .task;
    const agentTask = async (
      actor: Actor,
      fields: Record<string, unknown> = {},
    ) =>
      (
        await createTask(actor, {
          title: `Agent task ${++seed}`,
          origin: "owner_request",
          ownerQuote: "Tienine traccia",
          idempotencyKey: `views-${suffix}-${seed}`,
          ...fields,
        })
      ).task;

    const project = await page("Clinical report", "project");
    const person = await page("Giulia Rossi", "person");
    const minutes = await page(
      "Verbale 15-10",
      "note",
      "Presenti: tutti.\nDecidere come prosegue il monitoraggio entro il 16/10.\nAltro.",
    );
    const passage = "Decidere come prosegue il monitoraggio entro il 16/10.";
    const start = minutes.markdown.indexOf(passage);

    try {
      // Fixtures covering every Needs you group.
      const extracted: Awaited<ReturnType<typeof createTask>>["task"][] = [];
      for (const title of ["Decidere il monitoraggio", "Inviare il report"])
        extracted.push(
          (
            await createTask(keeper, {
              title: `${title} ${suffix}`,
              origin: "extracted",
              extractionFingerprint: sha(`${title}-${suffix}`),
              sourcePageRef: minutes.id,
              sourceVersion: minutes.version,
              sourceExcerpt: {
                startOffset: start,
                endOffset: start + passage.length,
              },
              batchId: taskBatchId(minutes.id, minutes.version),
              projectRef: project.id,
            })
          ).task,
        );
      const triage = await agentTask(codex, { projectRef: project.id });
      const asking = await ownerTask({
        title: `Question task ${suffix}`,
        priority: 1,
        projectRef: project.id,
      });
      const claim = await claimTask(claude, { ref: asking.ref });
      await reportTask(claude, {
        ref: asking.ref,
        leaseId: claim.leaseId,
        note: "Need a decision.",
        question: { prompt: "Which format?", choices: ["PDF", "Slides"] },
      });
      const requested = await agentTask(codex);
      await claimTask(claude, {
        ref: requested.ref,
        onOwnerRequest: { quote: "prendi questo task" },
      });
      const reviewed = await ownerTask({ reviewPolicy: "owner" });
      const reviewClaim = await claimTask(claude, { ref: reviewed.ref });
      await completeTask(claude, {
        ref: reviewed.ref,
        leaseId: reviewClaim.leaseId,
        summary: "Done, please check.",
      });
      const human = await ownerTask({ title: `Login gh ${suffix}` });
      await blockTask(owner, human.ref, {
        reason: "human_step",
        note: "Only the owner can sign in.",
      });
      const parked = await ownerTask({ title: `Parked ${suffix}` });
      await holdTask(owner, parked.ref, {});
      await pool.query(
        `INSERT INTO brain_task_suggestions (owner_id, task_id, kind, citations, confidence, policy_version, dedupe_key, payload, created_by_agent_id)
         VALUES ($1, $2, 'new_source', $3::jsonb, 0.91, 'task-keeper-v1', $4, '{}'::jsonb, $5)`,
        [
          ownerId,
          triage.id,
          JSON.stringify([
            { pageId: minutes.id, version: minutes.version, excerpt: passage },
          ]),
          `views-${suffix}`,
          keeper.agentId,
        ],
      );

      await t.test(
        "Needs you groups decisions by kind and source",
        async () => {
          const data = await queryNeedsYou(ownerId);
          const batch = data.triage.find((group) => group.batchId);
          assert.ok(batch, "the keeper's extraction forms a source batch");
          assert.equal(batch.source?.id, minutes.id);
          assert.equal(batch.source?.version, minutes.version);
          assert.deepEqual(
            batch.tasks.map((task) => task.ref).sort(),
            extracted.map((task) => task.ref).sort(),
          );
          assert.equal(batch.tasks[0].source?.passage, passage);
          assert.equal(batch.tasks[0].title.untrusted, true);
          const byAgent = data.triage.find(
            (group) => !group.batchId && group.createdBy.id === codex.agentId,
          );
          assert.deepEqual(
            byAgent?.tasks.map((task) => task.ref),
            [triage.ref],
            "codex's other task is claimed, so not in triage",
          );
          assert.equal(data.questions.length, 1);
          assert.equal(data.questions[0].task.ref, asking.ref);
          assert.equal(data.questions[0].prompt?.value, "Which format?");
          assert.deepEqual(data.questions[0].choices, ["PDF", "Slides"]);
          assert.equal(data.questions[0].stale, false);
          assert.equal(data.staleQuestions.length, 0);
          assert.deepEqual(
            data.onRequest.map((item) => [item.task.ref, item.quote.value]),
            [[requested.ref, "prendi questo task"]],
          );
          assert.deepEqual(
            data.reviews.map((task) => [
              task.ref,
              task.completion?.value.summary,
            ]),
            [[reviewed.ref, "Done, please check."]],
          );
          assert.deepEqual(
            data.humanSteps.map((task) => task.ref),
            [human.ref],
          );
          assert.equal(data.suggestions.length, 1);
          assert.equal(data.suggestions[0].task.ref, triage.ref);
          assert.deepEqual(data.suggestions[0].citations[0], {
            pageId: minutes.id,
            title: minutes.title,
            slug: minutes.slug,
            version: minutes.version,
            excerpt: passage,
          });
          assert.deepEqual(data.totals, {
            triage: 3,
            questions: 1,
            staleQuestions: 0,
            reviews: 1,
            humanSteps: 1,
            onRequest: 1,
            suggestions: 1,
          });
          // Claims on request are informational: not in the badge.
          assert.equal(await queryNeedsYouCount(ownerId), 3 + 1 + 1 + 1 + 1);
          const suggestion = await querySuggestion(
            ownerId,
            data.suggestions[0].id,
          );
          assert.equal(suggestion?.ref, triage.ref);
          assert.equal(suggestion?.taskId, triage.id);
          assert.equal(await querySuggestion(ownerId, "not-a-uuid"), null);
        },
      );

      await t.test("the table filters, sorts and paginates", async () => {
        const open = await queryTaskTable(ownerId, filters({}));
        assert.equal(open.total, open.rows.length);
        assert.ok(open.rows.every((row) => row.status !== "done"));
        assert.deepEqual(
          (
            await queryTaskTable(ownerId, filters({ query: asking.ref }))
          ).rows.map((row) => row.ref),
          [asking.ref],
        );
        const byProject = await queryTaskTable(
          ownerId,
          filters({ projectId: project.id }),
        );
        assert.deepEqual(
          byProject.rows.map((row) => row.ref).sort(),
          [...extracted.map((task) => task.ref), triage.ref, asking.ref].sort(),
        );
        assert.deepEqual(
          (
            await queryTaskTable(ownerId, filters({ priorities: [1] }))
          ).rows.map((row) => row.ref),
          [asking.ref],
        );
        const claudes = await queryTaskTable(
          ownerId,
          filters({ agentId: claude.agentId }),
        );
        // Holders, delegates and creators; a completed claim is no longer held.
        assert.deepEqual(
          claudes.rows.map((row) => row.ref).sort(),
          [asking.ref, requested.ref].sort(),
        );
        const held = await queryTaskTable(
          ownerId,
          filters({ statuses: ["on_hold"] }),
        );
        assert.deepEqual(
          held.rows.map((row) => row.ref),
          [parked.ref],
        );
        const newest = await queryTaskTable(
          ownerId,
          filters({ sort: "number", direction: "desc" }),
        );
        assert.deepEqual(
          newest.rows.map((row) => row.number),
          [...newest.rows.map((row) => row.number)].sort((a, b) => b - a),
        );
        const beyond = await queryTaskTable(ownerId, filters({ offset: 500 }));
        assert.equal(beyond.rows.length, 0);
        assert.equal(beyond.total, open.total);
        assert.equal(beyond.hasMore, false);
        const archived = await queryTaskTable(
          ownerId,
          filters({ archived: true }),
        );
        assert.equal(archived.total, 0);
      });

      await t.test("overview sections and the detail page", async () => {
        const overview = await queryTaskOverview(ownerId);
        assert.deepEqual(
          overview.inProgress.rows.map((row) => row.ref).sort(),
          [asking.ref, requested.ref].sort(),
        );
        assert.ok(
          overview.ready.rows.every((row) => row.approved),
          "unapproved ready tasks wait in triage",
        );
        assert.deepEqual(
          overview.waiting.rows.map((row) => row.ref).sort(),
          [human.ref, parked.ref].sort(),
        );

        const child = await ownerTask({ parentRef: asking.ref });
        await addTaskDependency(owner, asking.ref, human.ref);
        await addTaskParty(owner, triage.ref, {
          role: "lead",
          kind: "person",
          personPageRef: person.id,
        });
        const detail = await queryTaskDetail(ownerId, asking.ref);
        assert.equal(detail.task.ref, asking.ref);
        assert.deepEqual(detail.question?.choices, ["PDF", "Slides"]);
        assert.equal(detail.onRequest, null);
        assert.deepEqual(
          detail.dependencies.blockedBy.map((item) => item.ref),
          [human.ref],
        );
        assert.deepEqual(
          detail.children.map((item) => item.ref),
          [child.ref],
        );
        const requestedDetail = await queryTaskDetail(ownerId, requested.ref);
        assert.equal(
          requestedDetail.onRequest?.quote.value,
          "prendi questo task",
        );
        const extractedDetail = await queryTaskDetail(
          ownerId,
          extracted[0].ref,
        );
        assert.equal(extractedDetail.source?.passage, passage);
        assert.equal(extractedDetail.task.delegateId, null);
        assert.equal(
          JSON.stringify(detail).includes("lease_id") ||
            JSON.stringify(detail).includes(claim.leaseId),
          false,
          "the lease id never reaches a view",
        );

        const state = await queryTaskState(ownerId, requested.ref);
        assert.deepEqual(
          [state.status, state.approved],
          ["in_progress", false],
        );
        // An unapproved on-request claim returns where it started.
        assert.equal(boardMove(state, "triage"), "release");
      });

      await t.test("calendar days follow the owner's time zone", async () => {
        const late = await ownerTask({
          due: { kind: "datetime", at: "2031-10-31T23:30:00Z" },
        });
        const loose = await ownerTask({
          due: { kind: "approximate", text: "fine ottobre" },
        });
        const nov = await queryTaskCalendar(
          ownerId,
          "2031-11-01",
          "2031-11-01",
        );
        assert.deepEqual(
          nov.dated.map((row) => row.ref),
          [late.ref],
        );
        const oct = await queryTaskCalendar(
          ownerId,
          "2031-10-31",
          "2031-10-31",
        );
        assert.deepEqual(oct.dated, []);
        assert.ok(oct.loose.some((row) => row.ref === loose.ref));
      });

      await t.test("board, project and person sections", async () => {
        const done = await ownerTask({ title: `Recently done ${suffix}` });
        await closeTask(owner, done.ref, {});
        const old = await ownerTask({ title: `Long done ${suffix}` });
        await closeTask(owner, old.ref, {});
        await pool.query(
          "UPDATE brain_tasks SET completed_at = now() - interval '30 days' WHERE owner_id = $1 AND number = $2",
          [ownerId, old.number],
        );
        const board = await queryTaskBoard(ownerId, {
          projectId: "",
          query: "",
        });
        const refs = board.tasks.map((row) => row.ref);
        assert.equal(board.totals.done, 1, "a column counts every task");
        assert.ok(refs.includes(done.ref));
        assert.ok(!refs.includes(old.ref));
        assert.deepEqual(
          (
            await queryTaskBoard(ownerId, {
              projectId: project.id,
              query: "monitoraggio",
            })
          ).tasks.map((row) => row.ref),
          [extracted[0].ref],
        );

        const projectTasks = await queryProjectTasks(ownerId, project.id);
        assert.equal(projectTasks.total, 4);
        assert.equal(projectTasks.paused, false);
        const personTasks = await queryPersonTasks(ownerId, person.id);
        assert.deepEqual(
          personTasks.tasks.map((row) => [row.ref, row.roles]),
          [[triage.ref, ["lead"]]],
        );

        await updateAgent(ownerId, claude.agentId, {
          capabilities: ["repo:agent-brain", "web"],
        });
        const choices = await queryTaskFormChoices(ownerId);
        assert.deepEqual(
          choices.agents.map((agent) => agent.id).sort(),
          [claude.agentId, codex.agentId].sort(),
        );
        assert.deepEqual(choices.capabilities, ["repo:agent-brain", "web"]);

        // Operations lists the pages the task keeper never reads.
        assert.deepEqual(await queryKeeperExclusions(ownerId), []);
        await setKeeperExcluded(owner, person.id, true);
        assert.deepEqual(
          (await queryKeeperExclusions(ownerId)).map((page) => page.id),
          [person.id],
        );
        await setKeeperExcluded(owner, person.id, false);
        assert.deepEqual(await queryKeeperExclusions(ownerId), []);
      });

      await t.test(
        "the changes poll answers cheaply and only to the owner",
        async () => {
          const { token } = await createAgentToken(ownerId, {
            name: `Views reader ${suffix}`,
            scopes: ["brain:read"],
          });
          const call = async (
            query = "",
            headers: Record<string, string> = {},
          ) => {
            const response = await changes(
              new Request(`https://brain.example/api/tasks/changes${query}`, {
                headers: { authorization: `Bearer ${token}`, ...headers },
              }),
            );
            return { status: response.status, body: await response.json() };
          };
          await saveTaskView(owner, { name: "Urgent", query: "priority=0" });
          const first = await call();
          assert.equal(first.status, 200);
          assert.equal(first.body.latest, await queryTaskWatermark(ownerId));
          assert.match(
            first.body.latest,
            new RegExp(`^${await latestTaskEventId(ownerId)}\\.`),
            "the cursor starts with the newest event id",
          );
          assert.equal(first.body.changed, false);
          assert.equal(first.body.needsYou, await queryNeedsYouCount(ownerId));
          assert.deepEqual(
            first.body.views.map((view: { name: string; href: string }) => [
              view.name,
              view.href,
            ]),
            [["Urgent", "/tasks?priority=0"]],
          );
          const quiet = await call(`?after=${first.body.latest}`);
          assert.deepEqual(quiet.body, {
            latest: first.body.latest,
            changed: false,
          });
          await ownerTask({ title: `Fresh ${suffix}` });
          const moved = await call(`?after=${first.body.latest}`);
          assert.equal(moved.body.changed, true);
          assert.notEqual(moved.body.latest, first.body.latest);
          assert.equal(typeof moved.body.needsYou, "number");

          // Changes that write no task event still move the cursor: a
          // nightly suggestion, its expiry, and a saved view.
          let cursor: string = moved.body.latest;
          const expectChange = async (label: string) => {
            const polled = await call(`?after=${cursor}`);
            assert.equal(polled.body.changed, true, label);
            assert.notEqual(polled.body.latest, cursor, label);
            assert.equal(
              polled.body.needsYou,
              await queryNeedsYouCount(ownerId),
              label,
            );
            cursor = polled.body.latest;
            return polled.body;
          };
          const events = await latestTaskEventId(ownerId);
          const before = await queryNeedsYouCount(ownerId);
          const opened = await pool.query(
            `INSERT INTO brain_task_suggestions (owner_id, task_id, kind, citations, policy_version, dedupe_key, payload, created_by_agent_id)
             VALUES ($1, $2, 'triage_aging', '[]'::jsonb, 'task-keeper-v1', $3, '{}'::jsonb, $4) RETURNING id`,
            [ownerId, triage.id, `views-poll-${suffix}`, keeper.agentId],
          );
          const nightly = await expectChange("a suggestion opened");
          assert.equal(nightly.needsYou, before + 1);
          await pool.query(
            "UPDATE brain_task_suggestions SET status = 'expired', updated_at = now() WHERE owner_id = $1 AND id = $2",
            [ownerId, opened.rows[0].id],
          );
          assert.equal(
            (await expectChange("a suggestion expired")).needsYou,
            before,
          );
          await saveTaskView(owner, { name: "Mine", query: "priority=1" });
          assert.deepEqual(
            (await expectChange("a view saved")).views.map(
              (view: { name: string }) => view.name,
            ),
            ["Urgent", "Mine"],
          );
          assert.equal(
            await latestTaskEventId(ownerId),
            events,
            "none of these wrote a task event",
          );
          const malformed = await call("?after=1;DROP");
          assert.equal(malformed.status, 200);
          assert.equal(malformed.body.changed, false);
          assert.equal(
            (await call("", { authorization: "Bearer brain_nope" })).status,
            401,
          );
          process.env.TASKS_ENABLED = "false";
          assert.equal((await call()).status, 404);
          process.env.TASKS_ENABLED = "1";
        },
      );
    } finally {
      if (original.owner) process.env.BRAIN_OWNER_EMAIL = original.owner;
      else delete process.env.BRAIN_OWNER_EMAIL;
      if (original.embeddings)
        process.env.BRAIN_QUERY_EMBEDDINGS = original.embeddings;
      else delete process.env.BRAIN_QUERY_EMBEDDINGS;
      if (original.tasks) process.env.TASKS_ENABLED = original.tasks;
      else delete process.env.TASKS_ENABLED;
      for (const table of [
        "brain_task_events",
        "brain_tasks",
        "brain_task_settings",
        "brain_task_extraction_rejections",
        "brain_pages",
        "agent_tokens",
      ])
        await pool.query(`DELETE FROM ${table} WHERE owner_id = $1`, [ownerId]);
      await pool.query("DELETE FROM brain_agent_clients WHERE owner_id = $1", [
        ownerId,
      ]);
      await pool.query("DELETE FROM brain_agents WHERE owner_id = $1", [
        ownerId,
      ]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
      await pool.end();
    }
  },
);
