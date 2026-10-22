import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createAgentToken } from "../lib/agent-tokens";
import {
  AuthError,
  type Principal,
  principalFromAgentToken,
} from "../lib/auth-principal";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import { createBrainHandler } from "../lib/mcp/server";
import {
  type Actor,
  ownerActor,
  resolveActor,
  systemActor,
  updateAgent,
} from "../lib/tasks/actors";
import {
  claimTask,
  completeTask,
  releaseTask,
  reportTask,
} from "../lib/tasks/claims";
import {
  addTaskDependency,
  removeTaskDependency,
} from "../lib/tasks/dependencies";
import { eventsSince } from "../lib/tasks/events";
import {
  answerTask,
  approveTask,
  approveTasks,
  archiveTask,
  blockTask,
  cancelTask,
  closeTask,
  delegateTask,
  forceReleaseTask,
  holdTask,
  purgeTask,
  reopenTask,
  resumeTask,
  reviewTask,
  startTask,
  unblockTask,
} from "../lib/tasks/owner";
import { addTaskParty, removeTaskParty } from "../lib/tasks/parties";
import {
  createTask,
  listReadyQueue,
  listTasks,
  readTask,
  updateTask,
} from "../lib/tasks/service";
import {
  getTaskSettings,
  saveTaskView,
  setKeeperExcluded,
  setProjectPaused,
} from "../lib/tasks/settings";
import {
  addTaskLink,
  decideTaskLink,
  decideTaskSuggestion,
  listTaskSuggestions,
} from "../lib/tasks/suggestions";
import type { CacheInvalidation } from "../lib/workspace/cache";

const code =
  (expected: string, check?: (details: Record<string, unknown>) => void) =>
  (error: unknown) => {
    if (
      !(error instanceof BrainError || error instanceof AuthError) ||
      error.code !== expected
    )
      return false;
    if (check && error instanceof BrainError)
      check((error.details ?? {}) as Record<string, unknown>);
    return true;
  };

type Created = Awaited<ReturnType<typeof createTask>>;

test(
  "task service: creation, admission, claims, fencing, completion and owner powers",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `tasks-service-${ownerId}@example.invalid`;
    const suffix = ownerId.slice(0, 8);
    const originalOwner = process.env.BRAIN_OWNER_EMAIL;
    const originalEmbeddings = process.env.BRAIN_QUERY_EMBEDDINGS;
    const originalTasks = process.env.TASKS_ENABLED;
    process.env.BRAIN_OWNER_EMAIL = [originalOwner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Tasks Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    const scopes = ["brain:read", "brain:write"];
    const oauthPrincipal = (name: string): Principal => ({
      ownerId,
      scopes,
      kind: "oauth",
      clientId: `${name}-${suffix}`,
    });
    const tokenPrincipal = async (name: string) =>
      principalFromAgentToken(
        (await createAgentToken(ownerId, { name, scopes })).token,
      );
    const actors = {
      owner: await ownerActor(ownerId),
      claude: await resolveActor(ownerId, oauthPrincipal("claude-code")),
      codex: await resolveActor(ownerId, oauthPrincipal("codex")),
      grok: await resolveActor(ownerId, oauthPrincipal("grok")),
    };
    const workerPrincipal = await tokenPrincipal("Headless worker");
    let worker = await resolveActor(ownerId, workerPrincipal);
    const refresh = (actor: Actor) =>
      actor.credential === "session"
        ? ownerActor(ownerId)
        : resolveActor(
            ownerId,
            actor.credential === "token"
              ? workerPrincipal
              : {
                  ownerId,
                  scopes,
                  kind: "oauth",
                  clientId: actor.clientId as string,
                },
          );
    let keySeed = 0;
    const key = () => `key-${suffix}-${++keySeed}`;
    const page = async (
      title: string,
      type: "project" | "note" | "decision" | "person",
      actor: Actor = actors.owner,
    ) =>
      brain.write(
        ownerId,
        {
          title: `${title} ${suffix}`,
          type,
          markdown: `${title} body.`,
          expectedVersion: 0,
        },
        { actorAgentId: actor.agentId },
      );
    const agentTask = (
      actor: Actor,
      fields: Record<string, unknown> = {},
    ): Promise<Created> =>
      createTask(actor, {
        title: `Agent task ${++keySeed}`,
        origin: "owner_request",
        ownerQuote: "Tienine traccia",
        idempotencyKey: key(),
        ...fields,
      });
    const ownerTask = (fields: Record<string, unknown> = {}) =>
      createTask(actors.owner, { title: `Owner task ${++keySeed}`, ...fields });
    const eventsOf = async (taskId: string) =>
      (
        await pool.query(
          "SELECT action, from_status, to_status, note, payload, actor_agent_id FROM brain_task_events WHERE owner_id = $1 AND task_id = $2 ORDER BY id",
          [ownerId, taskId],
        )
      ).rows;
    const project = await page("Clinical report", "project");
    const otherProject = await page("Cash flow", "project");
    const note = await page("Meeting notes", "note");

    try {
      await t.test(
        "creation: numbering, policies, idempotency, allowlist and limits",
        async () => {
          const first = await agentTask(actors.claude, {
            title: `Prepare​ the monitoring ${suffix}`,
            projectRef: project.slug,
            contextPageRefs: [note.id],
            description: `See /pages/${project.slug} for scope.`,
            expectedOutput: "decision",
            idempotencyKey: "monitoring-001",
          });
          assert.equal(first.status, "triage");
          assert.equal(first.approved, false);
          assert.equal(first.replayed, false);
          assert.equal(
            first.task.title.value,
            `Prepare the monitoring ${suffix}`,
          );
          assert.equal(first.task.title.untrusted, true);
          assert.equal(first.task.reviewPolicy, "owner");
          assert.match(first.task.ref, /^T-\d+$/);
          // Retrieval adds machine suggestions that depend on the shared corpus.
          assert.ok(
            first.linked
              .filter((link) => link.origin === "rule")
              .every((link) => link.status === "suggested"),
          );
          assert.deepEqual(
            first.linked
              .filter((link) => link.origin !== "rule")
              .map(
                (link) =>
                  `${link.role}:${link.origin}:${link.status}:${link.page.id}`,
              )
              .sort(),
            [
              `context:agent:active:${note.id}`,
              `context:agent:active:${project.id}`,
            ].sort(),
          );
          assert.ok(
            first.nextActions.some(
              (action) =>
                action.kind === "owner_action" &&
                action.url.endsWith(`/tasks/${first.task.ref}#approve`),
            ),
          );
          const replay = await agentTask(actors.claude, {
            title: `Prepare​ the monitoring ${suffix}`,
            projectRef: project.slug,
            contextPageRefs: [note.id],
            description: `See /pages/${project.slug} for scope.`,
            expectedOutput: "decision",
            idempotencyKey: "monitoring-001",
            ownerQuote: "Tienine traccia",
          });
          assert.equal(replay.replayed, true);
          assert.equal(replay.task.id, first.task.id);
          await assert.rejects(
            agentTask(actors.claude, {
              title: "A different task",
              idempotencyKey: "monitoring-001",
            }),
            code("IDEMPOTENCY_KEY_CONFLICT"),
          );
          // The same key from another agent is a different task.
          const otherAgent = await agentTask(actors.codex, {
            idempotencyKey: "monitoring-001",
          });
          assert.notEqual(otherAgent.task.id, first.task.id);
          const duplicate = await agentTask(actors.codex, {
            title: `Prepare the monitoring ${suffix} again`,
            projectRef: project.id,
          });
          assert.ok(
            duplicate.possibleDuplicates.some(
              (item) => item.ref === first.task.ref,
            ),
          );

          const parallel = await Promise.all(
            Array.from({ length: 8 }, () => ownerTask()),
          );
          const numbers = parallel
            .map((item) => item.task.number)
            .sort((a, b) => a - b);
          assert.equal(new Set(numbers).size, 8);
          assert.equal(numbers[7] - numbers[0], 7);
          assert.ok(
            parallel.every((item) => item.status === "ready" && item.approved),
          );

          await assert.rejects(
            agentTask(actors.claude, {
              origin: "subtask",
              parentRef: parallel[0].task.ref,
              ownerQuote: undefined,
            }),
            code("NOT_TASK_HOLDER"),
          );
          await assert.rejects(
            agentTask(actors.claude, { projectRef: note.slug }),
            code("PROJECT_NOT_FOUND"),
          );
          await assert.rejects(
            agentTask(actors.claude, { contextPageRefs: ["missing/page"] }),
            code("PAGE_NOT_FOUND"),
          );
          await assert.rejects(
            agentTask(actors.claude, { origin: "owner_ui" }),
            code("INVALID_INPUT"),
          );
          await assert.rejects(
            agentTask(await systemActor(ownerId, "consolidator"), {}),
            code("NOT_ALLOWED"),
          );

          await updateAgent(ownerId, actors.codex.agentId, {
            createPolicy: "direct",
          });
          actors.codex = await refresh(actors.codex);
          const direct = await agentTask(actors.codex);
          assert.equal(direct.status, "ready");
          assert.equal(direct.approved, false);

          // trusted_creator only applies to the agent's own token, never OAuth.
          await updateAgent(ownerId, worker.agentId, { trustedCreator: true });
          worker = await refresh(worker);
          const trusted = await agentTask(worker);
          assert.equal(trusted.status, "ready");
          assert.equal(trusted.approved, true);
          await updateAgent(ownerId, worker.agentId, { trustedCreator: false });
          worker = await refresh(worker);
        },
      );

      await t.test(
        "per-agent limits: 20 open triage tasks and 50 a day",
        async () => {
          const busy = await resolveActor(ownerId, oauthPrincipal("busy"));
          await pool.query(
            `INSERT INTO brain_tasks (owner_id, number, title, origin, created_by_agent_id)
           SELECT $1, 100000 + g, 'Filler ' || g, 'owner_request', $2 FROM generate_series(1, 20) g`,
            [ownerId, busy.agentId],
          );
          await assert.rejects(
            agentTask(busy),
            code("RATE_LIMITED", (details) => assert.equal(details.limit, 20)),
          );
          await pool.query(
            `INSERT INTO brain_tasks (owner_id, number, title, origin, status, created_by_agent_id)
           SELECT $1, 100100 + g, 'Filler ' || g, 'owner_request', 'ready', $2 FROM generate_series(1, 30) g`,
            [ownerId, busy.agentId],
          );
          await updateAgent(ownerId, busy.agentId, { createPolicy: "direct" });
          await assert.rejects(
            agentTask(await refresh(busy)),
            code("RATE_LIMITED", (details) => {
              assert.equal(details.limit, 50);
              assert.ok(Number(details.retryAfterSeconds) > 0);
            }),
          );
          await pool.query(
            "DELETE FROM brain_tasks WHERE owner_id = $1 AND created_by_agent_id = $2",
            [ownerId, busy.agentId],
          );
        },
      );

      await t.test(
        "claim admission: approval, delegation, capability, human lead, pause",
        async () => {
          const triage = await agentTask(actors.claude);
          await assert.rejects(
            claimTask(actors.grok, { ref: triage.task.ref }),
            code("NOT_CLAIMABLE", (details) =>
              assert.equal(details.reason, "not_approved"),
            ),
          );
          const own = await claimTask(actors.claude, { ref: triage.task.ref });
          assert.equal(own.claimedFrom, "own_triage");
          await releaseTask(actors.claude, {
            ref: triage.task.ref,
            leaseId: own.leaseId,
            reason: "handoff",
            note: "Back to the pile",
          });
          // A claim never approves: the creator's release returns it to triage.
          assert.equal(
            (await readTask(actors.claude, { ref: triage.task.ref })).task
              .status,
            "triage",
          );

          const direct = await agentTask(actors.codex);
          await assert.rejects(
            claimTask(actors.claude, { ref: direct.task.ref }),
            code("NOT_CLAIMABLE", (details) =>
              assert.equal(details.reason, "not_approved"),
            ),
          );
          const claimable = await listTasks(actors.claude, {
            claimable: true,
            limit: 50,
          });
          assert.ok(
            !claimable.tasks.some((task) => task.ref === direct.task.ref),
          );
          assert.ok(
            (
              await listTasks(actors.codex, { claimable: true, limit: 50 })
            ).tasks.some((task) => task.ref === direct.task.ref),
          );

          const delegated = await ownerTask();
          await delegateTask(actors.owner, delegated.task.ref, {
            agentId: actors.codex.agentId,
          });
          for (const input of [
            { ref: delegated.task.ref },
            {
              ref: delegated.task.ref,
              onOwnerRequest: { quote: "prendi questo" },
            },
          ])
            await assert.rejects(
              claimTask(actors.claude, input),
              code("NOT_CLAIMABLE", (details) => {
                assert.equal(details.reason, "assigned_to_other_agent");
                assert.equal(details.agent, actors.codex.agent.label);
              }),
            );

          const capable = await createTask(actors.owner, {
            title: `Repository work ${suffix}`,
            requiredCapability: "repo:agent-brain",
          });
          await assert.rejects(
            claimTask(actors.claude, { ref: capable.task.ref }),
            code("NOT_CLAIMABLE", (details) =>
              assert.equal(details.reason, "missing_capability"),
            ),
          );
          await updateAgent(ownerId, actors.grok.agentId, {
            capabilities: ["repo:agent-brain"],
          });
          actors.grok = await refresh(actors.grok);
          const withCapability = await claimTask(actors.grok, {
            ref: capable.task.ref,
          });
          assert.equal(withCapability.claimedFrom, "ready");
          await assert.rejects(
            claimTask(actors.claude, { ref: capable.task.ref }),
            code("LEASE_HELD", (details) =>
              assert.equal(details.holder, actors.grok.agent.label),
            ),
          );

          const led = await ownerTask({ projectRef: otherProject.slug });
          await addTaskParty(actors.owner, led.task.ref, {
            role: "lead",
            kind: "group",
            groupLabel: "JSB team",
            sourceNote: "minuta 15/10",
          });
          await assert.rejects(
            claimTask(actors.claude, { ref: led.task.ref }),
            code("NOT_CLAIMABLE", (details) => {
              assert.equal(details.reason, "human_lead");
              assert.deepEqual(details.leads, [
                {
                  value: "JSB team",
                  untrusted: false,
                  authoredBy: actors.owner.agent.label,
                },
              ]);
            }),
          );
          const paused = await ownerTask({ projectRef: project.slug });
          await setProjectPaused(actors.owner, project.slug, true);
          await assert.rejects(
            claimTask(actors.claude, { ref: paused.task.ref }),
            code("NOT_CLAIMABLE", (details) =>
              assert.equal(details.reason, "project_paused"),
            ),
          );
          const queue = (
            await listTasks(actors.claude, { claimable: true, limit: 50 })
          ).tasks.map((task) => task.ref);
          assert.ok(!queue.includes(led.task.ref));
          assert.ok(!queue.includes(paused.task.ref));
          assert.ok(
            !(await listReadyQueue(ownerId)).some(
              (task) =>
                task.ref === paused.task.ref || task.ref === led.task.ref,
            ),
          );
          await setProjectPaused(actors.owner, project.slug, false);
          assert.deepEqual(
            (await getTaskSettings(ownerId)).pausedProjectIds,
            [],
          );

          const human = await createTask(actors.owner, {
            title: `Play Console organization ${suffix}`,
            requiresHuman: true,
          });
          await assert.rejects(
            claimTask(actors.claude, {
              ref: human.task.ref,
              onOwnerRequest: { quote: "prendi T-x" },
            }),
            code("NOT_CLAIMABLE", (details) =>
              assert.equal(details.reason, "requires_human"),
            ),
          );
          const held = await ownerTask();
          await holdTask(actors.owner, held.task.ref);
          await assert.rejects(
            claimTask(actors.claude, {
              ref: held.task.ref,
              onOwnerRequest: { quote: "prendi" },
            }),
            code("NOT_CLAIMABLE", (details) =>
              assert.equal(details.status, "on_hold"),
            ),
          );
          await assert.rejects(
            claimTask(actors.owner, { ref: held.task.ref }),
            code("NOT_ALLOWED"),
          );
        },
      );

      await t.test(
        "claim on the owner's explicit request keeps leads and approves nothing",
        async () => {
          const foreign = await agentTask(actors.codex, {
            projectRef: otherProject.slug,
          });
          await updateAgent(ownerId, actors.codex.agentId, {
            createPolicy: "triage",
          });
          actors.codex = await refresh(actors.codex);
          const triage = await agentTask(actors.codex);
          await addTaskParty(actors.owner, triage.task.ref, {
            role: "lead",
            kind: "group",
            groupLabel: "JSB team",
          });
          await setProjectPaused(actors.owner, otherProject.slug, true);
          const quote = `prendi ${triage.task.ref}`;
          const claimed = await claimTask(actors.claude, {
            ref: triage.task.ref,
            onOwnerRequest: { quote },
          });
          assert.equal(claimed.claimedFrom, "owner_request");
          assert.equal(claimed.task.status, "in_progress");
          assert.equal(claimed.task.approved, false);
          const claimedEvent = (await eventsOf(triage.task.id)).find(
            (event) => event.action === "claimed",
          );
          assert.equal(
            claimedEvent.note,
            "On the owner's request, lead: JSB team",
          );
          assert.deepEqual(claimedEvent.payload.ownerRequest, { quote });
          assert.equal(claimedEvent.payload.startStatus, "triage");
          assert.deepEqual(claimedEvent.payload.leads, ["JSB team"]);
          const parties = (
            await readTask(actors.claude, { ref: triage.task.ref })
          ).parties;
          assert.deepEqual(
            parties.map((party) => `${party.role}:${party.label.value}`),
            ["lead:JSB team"],
          );
          await releaseTask(actors.claude, {
            ref: triage.task.ref,
            leaseId: claimed.leaseId,
            reason: "handoff",
            note: "Done with my part",
          });
          const after = await readTask(actors.grok, { ref: triage.task.ref });
          assert.equal(after.task.status, "triage");
          assert.equal(after.task.approved, false);
          await assert.rejects(
            claimTask(actors.grok, { ref: triage.task.ref }),
            code("NOT_CLAIMABLE"),
          );
          // Paused project and a ready-but-unapproved task of another agent.
          const paused = await claimTask(actors.claude, {
            ref: foreign.task.ref,
            onOwnerRequest: { quote: "lavora su questo" },
          });
          assert.equal(paused.claimedFrom, "owner_request");
          await setProjectPaused(actors.owner, otherProject.slug, false);

          await assert.rejects(
            claimTask(worker, {
              ref: triage.task.ref,
              onOwnerRequest: { quote: "prendi" },
            }),
            code("CLAIM_ON_REQUEST_DISABLED"),
          );
          await updateAgent(ownerId, worker.agentId, { claimOnRequest: true });
          worker = await refresh(worker);
          const enabled = await claimTask(worker, {
            ref: triage.task.ref,
            onOwnerRequest: { quote: "prendi" },
          });
          assert.equal(enabled.claimedFrom, "owner_request");
          // The owner's Revoke returns it to its start state.
          await forceReleaseTask(actors.owner, triage.task.ref);
          assert.equal(
            (await readTask(actors.owner, { ref: triage.task.ref })).task
              .status,
            "triage",
          );
        },
      );

      await t.test(
        "20 concurrent claim_task{next} on 5 tasks yield exactly 5 claims",
        async () => {
          const arena = await page("Concurrency arena", "project");
          const tasks = await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
              ownerTask({ projectRef: arena.id, priority: index % 4 }),
            ),
          );
          const contenders = [actors.claude, actors.codex, actors.grok, worker];
          const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, index) =>
              claimTask(contenders[index % contenders.length], {
                next: { projectRef: arena.slug },
              }),
            ),
          );
          const won = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          );
          assert.equal(won.length, 5);
          assert.deepEqual(
            won.map((claim) => claim.task.id).sort(),
            tasks.map((task) => task.task.id).sort(),
          );
          assert.equal(new Set(won.map((claim) => claim.leaseId)).size, 5);
          for (const result of results)
            if (result.status === "rejected")
              assert.ok(
                code("NO_CLAIMABLE_TASK", (details) =>
                  assert.equal(details.retryAfterSeconds, 300),
                )(result.reason),
                String(result.reason),
              );
          const claimCounts = await pool.query(
            "SELECT claim_count FROM brain_tasks WHERE owner_id = $1 AND project_page_id = $2",
            [ownerId, arena.id],
          );
          assert.ok(claimCounts.rows.every((row) => row.claim_count === 1));
        },
      );

      await t.test(
        "fencing: renewal, LEASE_LOST, NOT_TASK_HOLDER and a secret lease id",
        async () => {
          const task = await ownerTask({
            acceptanceCriteria: ["Report drafted"],
          });
          const claimed = await claimTask(actors.claude, {
            ref: task.task.ref,
            leaseMinutes: 60,
            clientRunId: "run-42",
          });
          assert.ok(
            Date.parse(claimed.reportBy) < Date.parse(claimed.leaseExpiresAt),
          );
          assert.deepEqual(claimed.requiredReport, [
            "summary",
            "criteria",
            "pagesChanged",
            "artifacts",
            "remaining",
          ]);
          assert.ok(claimed.brief.markdown.length <= 12_000);
          const before = await readTask(actors.claude, { ref: task.task.ref });
          const report = await reportTask(actors.claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            note: "Halfway",
          });
          assert.equal(report.status, "in_progress");
          assert.ok(
            Date.parse(report.leaseExpiresAt as string) >=
              Date.parse(claimed.leaseExpiresAt) - 1000,
          );
          const after = await readTask(actors.claude, { ref: task.task.ref });
          assert.equal(after.task.version, before.task.version);
          assert.equal(after.you.holder, true);
          await assert.rejects(
            reportTask(actors.codex, {
              ref: task.task.ref,
              leaseId: claimed.leaseId,
              note: "Leaked",
            }),
            code("NOT_TASK_HOLDER"),
          );
          await assert.rejects(
            reportTask(actors.codex, {
              ref: task.task.ref,
              leaseId: randomUUID(),
              note: "Guess",
            }),
            code("NOT_TASK_HOLDER"),
          );
          await pool.query(
            "UPDATE brain_tasks SET lease_expires_at = now() - interval '1 minute' WHERE owner_id = $1 AND id = $2",
            [ownerId, task.task.id],
          );
          const taken = await claimTask(actors.codex, { ref: task.task.ref });
          assert.equal(taken.claimedFrom, "expired_lease");
          for (const call of [
            () =>
              reportTask(actors.claude, {
                ref: task.task.ref,
                leaseId: claimed.leaseId,
                note: "Still here",
              }),
            () =>
              completeTask(actors.claude, {
                ref: task.task.ref,
                leaseId: claimed.leaseId,
                summary: "Done",
              }),
            () =>
              releaseTask(actors.claude, {
                ref: task.task.ref,
                leaseId: claimed.leaseId,
                reason: "failed",
                note: "Lost",
              }),
          ])
            await assert.rejects(call(), code("LEASE_LOST"));
          const visible = JSON.stringify([
            await readTask(actors.codex, {
              ref: task.task.ref,
              eventsLimit: 50,
            }),
            await listTasks(actors.codex, { mine: true }),
            await eventsSince(ownerId, {}),
          ]);
          for (const lease of [claimed.leaseId, taken.leaseId])
            assert.equal(visible.includes(lease), false);
          const stored = JSON.stringify(await eventsOf(task.task.id));
          assert.equal(stored.includes(taken.leaseId), false);

          const done = await completeTask(actors.codex, {
            ref: task.task.ref,
            leaseId: taken.leaseId,
            summary: "Report drafted and checked",
            criteria: [
              {
                index: 0,
                status: "met",
                evidence: "Draft in the project page",
                verification: "observed",
              },
            ],
          });
          assert.equal(done.status, "done");
          assert.equal(done.replayed, false);
          const replay = await completeTask(actors.codex, {
            ref: task.task.ref,
            leaseId: taken.leaseId.toUpperCase(),
            summary: "Report drafted and checked",
            criteria: [
              {
                index: 0,
                status: "met",
                evidence: "Draft in the project page",
                verification: "observed",
              },
            ],
          });
          assert.equal(replay.replayed, true);
          assert.equal(replay.status, "done");
          await assert.rejects(
            completeTask(actors.codex, {
              ref: task.task.ref,
              leaseId: taken.leaseId,
              summary: "Something else",
              criteria: [
                {
                  index: 0,
                  status: "met",
                  evidence: "x",
                  verification: "observed",
                },
              ],
            }),
            code("ALREADY_COMPLETED"),
          );
          const completed = await readTask(actors.owner, {
            ref: task.task.ref,
          });
          assert.equal(completed.task.completion?.untrusted, true);
          assert.equal(
            completed.task.completion?.authoredBy,
            actors.codex.agent.label,
          );
          assert.equal(completed.task.claimedBy, null);
        },
      );

      await t.test(
        "questions: needs_input, answers within 7 days, stale after 14",
        async () => {
          const task = await ownerTask();
          const claimed = await claimTask(actors.claude, {
            ref: task.task.ref,
          });
          const asked = await reportTask(actors.claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            note: "Need a decision",
            question: { prompt: "Which client list?", choices: ["A", "B"] },
          });
          assert.equal(asked.status, "needs_input");
          assert.equal(asked.leaseExpiresAt, null);
          assert.equal(asked.pollAfterSeconds, 60);
          assert.ok(
            asked.nextActions.some(
              (action) =>
                action.kind === "owner_action" &&
                action.url.endsWith(`/tasks/${task.task.ref}#answer`),
            ),
          );
          await assert.rejects(
            claimTask(actors.codex, { ref: task.task.ref }),
            code("LEASE_HELD"),
          );
          const waiting = await readTask(actors.claude, { ref: task.task.ref });
          assert.equal(waiting.task.statusNote?.value, "Which client list?");
          assert.equal(
            waiting.task.statusNote?.authoredBy,
            actors.claude.agent.label,
          );
          await answerTask(actors.owner, task.task.ref, {
            answer: "Use list B",
            choice: "B",
          });
          const resumed = await readTask(actors.claude, { ref: task.task.ref });
          assert.equal(resumed.task.status, "in_progress");
          assert.equal(resumed.ownerAnswer?.answer, "Use list B");
          const mine = await listTasks(actors.claude, { mine: true });
          assert.equal(
            mine.tasks.find((row) => row.ref === task.task.ref)?.ownerAnswer
              ?.choice,
            "B",
          );
          const report = await reportTask(actors.claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            note: "Continuing with B",
          });
          assert.equal(report.ownerAnswer?.answer, "Use list B");
          assert.ok(report.leaseExpiresAt);

          await reportTask(actors.claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            note: "One more",
            question: { prompt: "Send the draft to the client?" },
          });
          await pool.query(
            "UPDATE brain_tasks SET input_requested_at = now() - interval '15 days' WHERE owner_id = $1 AND id = $2",
            [ownerId, task.task.id],
          );
          const stale = await claimTask(actors.codex, { ref: task.task.ref });
          assert.equal(stale.claimedFrom, "stale_question");
          assert.ok(
            stale.brief.markdown.includes("Send the draft to the client?"),
          );
          assert.ok(stale.brief.markdown.includes("Use list B"));
          await assert.rejects(
            reportTask(actors.claude, {
              ref: task.task.ref,
              leaseId: claimed.leaseId,
              note: "Hello?",
            }),
            code("LEASE_LOST"),
          );

          await reportTask(actors.codex, {
            ref: task.task.ref,
            leaseId: stale.leaseId,
            note: "Asking again",
            question: { prompt: "Still send it?" },
          });
          await pool.query(
            "UPDATE brain_tasks SET input_requested_at = now() - interval '8 days' WHERE owner_id = $1 AND id = $2",
            [ownerId, task.task.id],
          );
          await answerTask(actors.owner, task.task.ref, { answer: "No" });
          const late = await readTask(actors.codex, { ref: task.task.ref });
          assert.equal(late.task.status, "ready");
          assert.equal(late.task.claimedBy, null);
          await assert.rejects(
            reportTask(actors.codex, {
              ref: task.task.ref,
              leaseId: stale.leaseId,
              note: "Back",
            }),
            code("LEASE_LOST"),
          );
          await assert.rejects(
            answerTask(actors.owner, task.task.ref, { answer: "Again" }),
            code("INVALID_TRANSITION"),
          );
        },
      );

      await t.test(
        "completion: report checks, output, pagesChanged verification, review",
        async () => {
          const task = await createTask(actors.owner, {
            title: `Write the recommendation ${suffix}`,
            acceptanceCriteria: ["Options compared", "Recommendation written"],
            expectedOutput: "page",
            projectRef: project.id,
          });
          const before = await page("Earlier write", "note", actors.claude);
          const claimed = await claimTask(actors.claude, {
            ref: task.task.ref,
          });
          const base = { ref: task.task.ref, leaseId: claimed.leaseId };
          await assert.rejects(
            completeTask(actors.claude, { ...base, summary: "Done" }),
            code("REPORT_INCOMPLETE", (details) =>
              assert.deepEqual(details.missing, ["criteria[0]", "criteria[1]"]),
            ),
          );
          const criteria = [
            {
              index: 0,
              status: "met" as const,
              evidence: "Table in the page",
              verification: "observed" as const,
            },
            {
              index: 1,
              status: "partial" as const,
              evidence: "Draft only",
              verification: "self_reported" as const,
            },
          ];
          await assert.rejects(
            completeTask(actors.claude, { ...base, summary: "Done", criteria }),
            code("REPORT_INCOMPLETE", (details) =>
              assert.deepEqual(details.missing, ["remaining"]),
            ),
          );
          await assert.rejects(
            completeTask(actors.claude, {
              ...base,
              summary: "Done",
              criteria: [...criteria, { ...criteria[0], index: 5 }],
              remaining: "Polish",
            }),
            code("INVALID_INPUT"),
          );
          await assert.rejects(
            completeTask(actors.claude, {
              ...base,
              summary: "Done",
              criteria,
              remaining: "Polish",
              pagesChanged: [{ ref: before.id, version: 1 }],
            }),
            code("OUTPUT_REQUIRED"),
            "a revision from before the claim is not this task's output",
          );
          const mine = await brain.append(
            ownerId,
            {
              ref: project.id,
              expectedVersion: (await brain.read(ownerId, { ref: project.id }))
                .version,
              markdown: "Recommendation: option B.",
            },
            { actorAgentId: actors.claude.agentId },
          );
          const theirs = await page("Codex notes", "note", actors.codex);
          const result = await completeTask(actors.claude, {
            ...base,
            summary: "Recommendation written",
            criteria,
            remaining: "Polish the wording",
            pagesChanged: [
              { ref: project.slug, version: mine.version },
              { ref: theirs.id, version: 1 },
              { ref: note.id, version: 99 },
              { ref: "missing/page", version: 1 },
            ],
            artifacts: [{ kind: "url", value: "https://example.invalid/pr/1" }],
          });
          assert.equal(result.status, "done");
          assert.deepEqual(
            result.producedLinks.map((link) => `${link.pageId}:${link.status}`),
            [`${project.id}:active`, `${theirs.id}:suggested`],
          );
          assert.deepEqual(result.ignoredPages, [
            { ref: note.id, reason: "no_revision" },
            { ref: "missing/page", reason: "page_not_found" },
          ]);
          const links = (await readTask(actors.owner, { ref: task.task.ref }))
            .links;
          assert.ok(
            links.some(
              (link) =>
                link.role === "produced" &&
                link.origin === "provenance" &&
                link.status === "active" &&
                link.page.id === project.id,
            ),
          );

          const decision = await createTask(actors.owner, {
            title: `Decide the monitoring ${suffix}`,
            expectedOutput: "decision",
          });
          assert.equal(decision.task.reviewPolicy, "owner");
          const decisionClaim = await claimTask(actors.claude, {
            ref: decision.task.ref,
          });
          await assert.rejects(
            completeTask(actors.claude, {
              ref: decision.task.ref,
              leaseId: decisionClaim.leaseId,
              summary: "Decided",
            }),
            code("OUTPUT_REQUIRED"),
          );
          const decisionPage = await page(
            "Monitoring decision",
            "decision",
            actors.claude,
          );
          const reviewed = await completeTask(actors.claude, {
            ref: decision.task.ref,
            leaseId: decisionClaim.leaseId,
            summary: "Decision recorded",
            pagesChanged: [
              { ref: decisionPage.slug, version: decisionPage.version },
            ],
          });
          assert.equal(reviewed.status, "in_review");
          assert.ok(
            reviewed.nextActions.some(
              (action) =>
                action.kind === "owner_action" &&
                action.url.endsWith("#review"),
            ),
          );
          await assert.rejects(
            reviewTask(actors.owner, decision.task.ref, {
              decision: "request_changes",
            }),
            code("INVALID_INPUT"),
          );
          const approved = await reviewTask(actors.owner, decision.task.ref, {
            decision: "approve",
          });
          assert.equal(approved.status, "done");
          assert.ok(approved.completedAt);

          const artifact = await createTask(actors.owner, {
            title: `Ship the fix ${suffix}`,
            expectedOutput: "artifact",
          });
          const artifactClaim = await claimTask(actors.claude, {
            ref: artifact.task.ref,
          });
          await assert.rejects(
            completeTask(actors.claude, {
              ref: artifact.task.ref,
              leaseId: artifactClaim.leaseId,
              summary: "Shipped",
            }),
            code("OUTPUT_REQUIRED"),
          );
          await decideTaskLink(actors.owner, task.task.ref, {
            pageRef: theirs.id,
            role: "produced",
            decision: "rejected",
          });
          assert.ok(
            !(await readTask(actors.owner, { ref: task.task.ref })).links.some(
              (link) => link.page.id === theirs.id,
            ),
          );
        },
      );

      await t.test(
        "updates: versions, creator rights until approval, holder links only",
        async () => {
          const own = await agentTask(actors.claude, {
            projectRef: project.id,
          });
          const edited = await updateTask(actors.claude, {
            ref: own.task.ref,
            expectedVersion: own.task.version,
            patch: {
              title: `Renamed task ${suffix}`,
              due: {
                kind: "event",
                text: "prossima riunione",
                sourceExcerpt: "entro la prossima riunione",
              },
            },
          });
          assert.deepEqual(edited.changedFields, ["title", "due"]);
          assert.equal(edited.task.version, own.task.version + 1);
          assert.equal(edited.task.due.kind, "event");
          await assert.rejects(
            updateTask(actors.claude, {
              ref: own.task.ref,
              expectedVersion: own.task.version,
              patch: { priority: 0 },
            }),
            code("TASK_VERSION_CONFLICT", (details) =>
              assert.equal(details.currentVersion, own.task.version + 1),
            ),
          );
          await assert.rejects(
            updateTask(actors.codex, {
              ref: own.task.ref,
              expectedVersion: edited.task.version,
              patch: { priority: 0 },
            }),
            code("NOT_ALLOWED"),
          );
          const approved = await approveTask(actors.owner, own.task.ref);
          assert.equal(approved.status, "ready");
          assert.equal(approved.version, edited.task.version + 1);
          await assert.rejects(
            updateTask(actors.claude, {
              ref: own.task.ref,
              expectedVersion: approved.version,
              patch: { title: "Hijacked" },
            }),
            code("NOT_ALLOWED"),
          );
          await assert.rejects(
            approveTask(actors.claude, own.task.ref),
            code("NOT_ALLOWED"),
          );
          const claimed = await claimTask(actors.codex, { ref: own.task.ref });
          const linked = await updateTask(actors.codex, {
            ref: own.task.ref,
            expectedVersion: approved.version,
            patch: { contextPageRefs: { add: [otherProject.slug] } },
          });
          assert.deepEqual(linked.changedFields, ["contextPageRefs"]);
          assert.equal(linked.task.version, approved.version);
          await assert.rejects(
            updateTask(actors.codex, {
              ref: own.task.ref,
              expectedVersion: approved.version,
              patch: { description: "My own scope" },
            }),
            code("NOT_ALLOWED"),
          );
          await releaseTask(actors.codex, {
            ref: own.task.ref,
            leaseId: claimed.leaseId,
            reason: "blocked",
            blockedReason: "human_step",
            note: "Needs the gh workflow scope",
          });
          const blocked = await readTask(actors.owner, { ref: own.task.ref });
          assert.equal(blocked.task.status, "blocked");
          assert.equal(blocked.task.blockedReason, "human_step");

          const cancelable = await agentTask(actors.claude);
          const canceled = await updateTask(actors.claude, {
            ref: cancelable.task.ref,
            expectedVersion: cancelable.task.version,
            patch: { status: "canceled" },
          });
          assert.equal(canceled.task.status, "canceled");
          const approvedTask = await agentTask(actors.claude);
          await approveTask(actors.owner, approvedTask.task.ref);
          await assert.rejects(
            updateTask(actors.claude, {
              ref: approvedTask.task.ref,
              expectedVersion: approvedTask.task.version + 1,
              patch: { status: "canceled" },
            }),
            code("NOT_ALLOWED"),
          );
          const ownerEdit = await updateTask(actors.owner, {
            ref: approvedTask.task.ref,
            expectedVersion: approvedTask.task.version + 1,
            patch: { expectedOutput: "external_action" },
          });
          assert.equal(ownerEdit.task.reviewPolicy, "owner");
          await assert.rejects(
            updateTask(actors.owner, {
              ref: approvedTask.task.ref,
              expectedVersion: ownerEdit.task.version,
              patch: { reviewPolicy: "auto" },
            }),
            code("INVALID_INPUT"),
          );
        },
      );

      await t.test(
        "dependencies: cycles refused, the queue waits, completion unblocks",
        async () => {
          const lane = await page("Dependency lane", "project");
          const [a, b, c] = await Promise.all(
            ["A", "B", "C"].map((name) =>
              ownerTask({
                title: `Step ${name} ${suffix}`,
                projectRef: lane.id,
              }),
            ),
          );
          await addTaskDependency(actors.owner, b.task.ref, a.task.ref);
          await addTaskDependency(actors.owner, c.task.ref, b.task.ref);
          await assert.rejects(
            addTaskDependency(actors.owner, a.task.ref, c.task.ref),
            code("DEPENDENCY_CYCLE"),
          );
          await assert.rejects(
            addTaskDependency(actors.owner, a.task.ref, a.task.ref),
            code("DEPENDENCY_CYCLE"),
          );
          await assert.rejects(
            addTaskDependency(actors.claude, a.task.ref, c.task.ref),
            code("NOT_ALLOWED"),
          );
          const queue = await listTasks(actors.claude, {
            claimable: true,
            projectRef: lane.id,
          });
          assert.deepEqual(
            queue.tasks.map((task) => task.ref),
            [a.task.ref],
          );
          const view = await readTask(actors.owner, { ref: b.task.ref });
          assert.deepEqual(view.dependencies.blockedBy, [
            { ref: a.task.ref, status: "ready" },
          ]);
          assert.deepEqual(view.dependencies.blocks, [
            { ref: c.task.ref, status: "ready" },
          ]);
          await blockTask(actors.owner, b.task.ref, { reason: "dependency" });
          const claimed = await claimTask(actors.claude, {
            next: { projectRef: lane.slug },
          });
          assert.equal(claimed.task.ref, a.task.ref);
          await completeTask(actors.claude, {
            ref: a.task.ref,
            leaseId: claimed.leaseId,
            summary: "Step A done",
          });
          const unblocked = await readTask(actors.owner, { ref: b.task.ref });
          assert.equal(unblocked.task.status, "ready");
          assert.equal(unblocked.task.blockedReason, null);
          assert.equal(
            unblocked.events.at(-1)?.payload.cause,
            "dependencies_done",
          );
          const next = await claimTask(actors.claude, {
            next: { projectRef: lane.slug },
          });
          assert.equal(next.task.ref, b.task.ref);
          await removeTaskDependency(actors.owner, c.task.ref, b.task.ref);
          assert.equal(
            (await readTask(actors.owner, { ref: c.task.ref })).task
              .openBlockers,
            0,
          );
        },
      );

      await t.test(
        "events since: a commit-safe cursor and changed tasks",
        async () => {
          const task = await ownerTask();
          const slow = await ownerTask();
          const start = (await listTasks(actors.owner, { limit: 1 }))
            .eventsCursor;
          const client = await pool.connect();
          const refs = [task.task.ref, slow.task.ref];
          try {
            // A slower transaction writes its event first but commits last; a
            // max(id) cursor would skip it, the xid8 watermark waits for it.
            await client.query("BEGIN");
            await client.query(
              `INSERT INTO brain_task_events (owner_id, task_id, actor_agent_id, action, note)
             VALUES ($1, $2, $3, 'note', 'slow writer')`,
              [ownerId, slow.task.id, actors.owner.agentId],
            );
            await holdTask(actors.owner, task.task.ref, { note: "Parked" });
            const during = await eventsSince(ownerId, { cursor: start });
            assert.equal(
              during.events.some((event) => refs.includes(event.ref ?? "")),
              false,
              "nothing past an open transaction is released",
            );
            await client.query("COMMIT");
          } finally {
            client.release();
          }
          const settled = await eventsSince(ownerId, { cursor: start });
          assert.deepEqual(
            settled.events
              .filter((event) => refs.includes(event.ref ?? ""))
              .map((event) => `${event.ref}:${event.action}`),
            [`${slow.task.ref}:note`, `${task.task.ref}:status_changed`],
          );
          const again = await eventsSince(ownerId, { cursor: settled.cursor });
          assert.equal(
            again.events.some((event) => refs.includes(event.ref ?? "")),
            false,
          );
          const changed = await listTasks(actors.owner, {
            changedSince: start,
            status: ["on_hold"],
          });
          assert.deepEqual(
            changed.tasks.map((row) => row.ref),
            [task.task.ref],
          );
          const scoped = await eventsSince(ownerId, {
            ref: task.task.ref,
            limit: 1,
          });
          assert.equal(scoped.events.length, 1);
          assert.equal(scoped.hasMore, true);
        },
      );

      await t.test(
        "purge leaves only a text-free event; parties, settings and views",
        async () => {
          const person = await page("Matteo Danti", "person");
          const task = await agentTask(actors.claude, {
            title: `Confidential AstraZeneca work ${suffix}`,
            contextPageRefs: [note.id],
          });
          const party = await addTaskParty(actors.owner, task.task.ref, {
            role: "support",
            kind: "person",
            personPageRef: person.slug,
          });
          assert.equal(party.label, person.title);
          await assert.rejects(
            addTaskParty(actors.owner, task.task.ref, {
              role: "lead",
              kind: "person",
              personPageRef: note.slug,
            }),
            code("PAGE_NOT_FOUND"),
          );
          await assert.rejects(
            addTaskParty(actors.claude, task.task.ref, {
              role: "lead",
              kind: "owner",
            }),
            code("NOT_ALLOWED"),
          );
          await removeTaskParty(actors.owner, task.task.ref, party.id);
          await addTaskParty(actors.owner, task.task.ref, {
            role: "lead",
            kind: "owner",
          });
          const cursor = (await listTasks(actors.owner, { limit: 1 }))
            .eventsCursor;
          await assert.rejects(
            purgeTask(actors.claude, task.task.ref),
            code("NOT_ALLOWED"),
          );
          assert.deepEqual(await purgeTask(actors.owner, task.task.ref), {
            ref: task.task.ref,
            purged: true,
          });
          for (const table of [
            "brain_tasks",
            "brain_task_links",
            "brain_task_parties",
          ]) {
            const column = table === "brain_tasks" ? "id" : "task_id";
            const { rowCount } = await pool.query(
              `SELECT 1 FROM ${table} WHERE owner_id = $1 AND ${column} = $2`,
              [ownerId, task.task.id],
            );
            assert.equal(rowCount, 0, table);
          }
          const { rows } = await pool.query(
            "SELECT task_id, note, payload, actor_agent_id FROM brain_task_events WHERE owner_id = $1 AND action = 'purged'",
            [ownerId],
          );
          assert.deepEqual(rows, [
            {
              task_id: null,
              note: null,
              payload: { number: task.task.number },
              actor_agent_id: actors.owner.agentId,
            },
          ]);
          const changed = await listTasks(actors.owner, {
            changedSince: cursor,
          });
          assert.deepEqual(changed.removed, [task.task.ref]);
          const next = await ownerTask();
          assert.ok(next.task.number > task.task.number);
          await assert.rejects(
            readTask(actors.owner, { ref: task.task.ref }),
            code("TASK_NOT_FOUND"),
          );

          await saveTaskView(actors.owner, {
            name: "Urgent",
            query: "status=ready&priority=0",
          });
          const settings = await setKeeperExcluded(
            actors.owner,
            note.slug,
            true,
          );
          assert.deepEqual(settings.keeperExcludedPageIds, [note.id]);
          assert.deepEqual(
            settings.savedViews.map((view) => view.name),
            ["Urgent"],
          );
          await assert.rejects(
            setProjectPaused(actors.owner, note.slug, true),
            code("PROJECT_NOT_FOUND"),
          );
          await assert.rejects(
            cancelTask(actors.codex, next.task.ref),
            code("NOT_ALLOWED"),
          );
        },
      );

      await t.test(
        "owner transitions, suggestions, links and full-text codes",
        async () => {
          const coded = await ownerTask({
            title: `AÜ.27 follow-up with Damato ${suffix}`,
          });
          assert.deepEqual(
            (await listTasks(actors.claude, { query: "AÜ.27" })).tasks.map(
              (task) => task.ref,
            ),
            [coded.task.ref],
          );
          const started = await startTask(actors.owner, coded.task.ref);
          assert.equal(started.status, "in_progress");
          assert.equal(started.claimedBy, null);
          await assert.rejects(
            claimTask(actors.claude, { ref: coded.task.ref }),
            code("NOT_CLAIMABLE", (details) =>
              assert.equal(details.reason, "status"),
            ),
          );
          await holdTask(actors.owner, coded.task.ref, { note: "HOLD" });
          assert.equal(
            (await resumeTask(actors.owner, coded.task.ref)).status,
            "ready",
          );
          const closed = await closeTask(actors.owner, coded.task.ref);
          assert.equal(closed.status, "done");
          await assert.rejects(
            closeTask(actors.owner, coded.task.ref),
            code("INVALID_TRANSITION"),
          );
          const reopened = await reopenTask(actors.owner, coded.task.ref, {
            note: "QA said NO-GO",
          });
          assert.equal(reopened.status, "ready");
          assert.equal(reopened.statusNote?.untrusted, false);
          await assert.rejects(
            startTask(actors.owner, coded.task.ref, {
              expectedVersion: reopened.version - 1,
            }),
            code("TASK_VERSION_CONFLICT"),
          );
          await blockTask(actors.owner, coded.task.ref, {
            reason: "external",
            note: "Waiting for the client",
          });
          assert.equal(
            (await unblockTask(actors.owner, coded.task.ref)).status,
            "ready",
          );
          const archived = await archiveTask(
            actors.owner,
            coded.task.ref,
            true,
          );
          assert.ok(archived.archivedAt);
          assert.ok(
            !(await listTasks(actors.owner, { limit: 50 })).tasks.some(
              (task) => task.ref === coded.task.ref,
            ),
          );
          await archiveTask(actors.owner, coded.task.ref, false);

          const batch = await Promise.all([
            agentTask(actors.claude),
            agentTask(actors.claude),
          ]);
          const approvedBatch = await approveTasks(
            actors.owner,
            batch.map((item) => item.task.ref),
          );
          assert.ok(
            approvedBatch.every(
              (task) => task.approved && task.status === "ready",
            ),
          );

          const keeper = await systemActor(ownerId, "task_keeper");
          await pool.query(
            `INSERT INTO brain_task_suggestions (owner_id, task_id, kind, policy_version, dedupe_key, payload, created_by_agent_id)
             VALUES ($1, $2, 'may_be_done', 'task-keeper-v1', $3, '{"transition":"close"}'::jsonb, $4),
                    ($1, $2, 'triage_aging', 'task-keeper-v1', $5, '{}'::jsonb, $4)`,
            [
              ownerId,
              batch[0].task.id,
              `may-be-done:${suffix}`,
              keeper.agentId,
              `aging:${suffix}`,
            ],
          );
          const open = await listTaskSuggestions(ownerId, {
            taskRef: batch[0].task.ref,
          });
          assert.equal(open.length, 2);
          const accepted = await decideTaskSuggestion(actors.owner, {
            id: open.find((item) => item.kind === "may_be_done")?.id,
            decision: "accepted",
          });
          assert.deepEqual(accepted.payload, { transition: "close" });
          await assert.rejects(
            decideTaskSuggestion(actors.claude, {
              id: open[0].id,
              decision: "dismissed",
            }),
            code("NOT_ALLOWED"),
          );
          await assert.rejects(
            decideTaskSuggestion(actors.owner, {
              id: accepted.id,
              decision: "dismissed",
            }),
            code("SUGGESTION_NOT_FOUND"),
          );
          assert.equal(
            (await listTaskSuggestions(ownerId, { taskRef: batch[0].task.ref }))
              .length,
            1,
          );

          await addTaskLink(actors.owner, batch[1].task.ref, {
            pageRef: otherProject.slug,
            role: "decision",
          });
          await updateTask(actors.owner, {
            ref: batch[1].task.ref,
            expectedVersion: approvedBatch[1].version,
            patch: { contextPageRefs: { add: [note.slug] } },
          });
          await updateTask(actors.owner, {
            ref: batch[1].task.ref,
            expectedVersion: approvedBatch[1].version,
            patch: { contextPageRefs: { remove: [note.slug] } },
          });
          const links = (
            await readTask(actors.owner, { ref: batch[1].task.ref })
          ).links;
          assert.deepEqual(
            links.map((link) => `${link.role}:${link.origin}:${link.page.id}`),
            [`decision:owner:${otherProject.id}`],
          );
          await assert.rejects(
            decideTaskLink(actors.owner, batch[1].task.ref, {
              pageRef: note.slug,
              role: "stakeholder",
              decision: "active",
            }),
            code("LINK_NOT_FOUND"),
          );
        },
      );

      await t.test(
        "MCP task tools sign as the calling agent and expire only tasks:<owner>",
        async () => {
          process.env.TASKS_ENABLED = "1";
          const kinds: CacheInvalidation[] = [];
          const handler = createBrainHandler(
            oauthPrincipal("mcp-client"),
            (kind) => kinds.push(kind),
          );
          const client = new Client(
            { name: "tasks-service-test", version: "1.0.0" },
            { versionNegotiation: { mode: { pin: "2026-07-28" } } },
          );
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL("https://brain.example/mcp"),
              {
                fetch: (input, init) => handler.fetch(new Request(input, init)),
              },
            ),
          );
          try {
            const data = (
              response: Awaited<ReturnType<typeof client.callTool>>,
            ) => {
              assert.equal(
                response.isError,
                undefined,
                JSON.stringify(response.content),
              );
              return (
                response.structuredContent as { data: Record<string, never> }
              ).data;
            };
            const created = data(
              await client.callTool({
                name: "create_task",
                arguments: {
                  title: `MCP task ${suffix}`,
                  origin: "owner_request",
                  ownerQuote: "crea un task per il report",
                  idempotencyKey: `mcp-${suffix}`,
                },
              }),
            ) as unknown as Created;
            assert.equal(created.status, "triage");
            assert.equal(created.task.createdBy.label, `mcp-client-${suffix}`);
            const claimed = data(
              await client.callTool({
                name: "claim_task",
                arguments: { ref: created.task.ref },
              }),
            ) as unknown as { leaseId: string };
            data(
              await client.callTool({
                name: "report_task",
                arguments: {
                  ref: created.task.ref,
                  leaseId: claimed.leaseId,
                  note: "Working",
                },
              }),
            );
            data(
              await client.callTool({
                name: "list_tasks",
                arguments: { mine: true },
              }),
            );
            assert.deepEqual(kinds, ["tasks", "tasks", "tasks"]);
            const written = data(
              await client.callTool({
                name: "write",
                arguments: {
                  title: `MCP page ${suffix}`,
                  type: "note",
                  markdown: "Signed by the client agent.",
                  expectedVersion: 0,
                },
              }),
            ) as unknown as { id: string };
            assert.deepEqual(kinds.at(-1), "workspace");
            const signer = await pool.query(
              "SELECT a.label FROM brain_revisions r JOIN brain_agents a ON a.owner_id = r.owner_id AND a.id = r.actor_agent_id WHERE r.owner_id = $1 AND r.page_id = $2",
              [ownerId, written.id],
            );
            assert.equal(signer.rows[0].label, `mcp-client-${suffix}`);
            const failed = await client.callTool({
              name: "claim_task",
              arguments: { ref: created.task.ref },
            });
            assert.equal(failed.isError, true);
            const error = (
              failed.structuredContent as {
                error: {
                  code: string;
                  details: { holder: string; remedy: string };
                };
              }
            ).error;
            assert.equal(error.code, "LEASE_HELD");
            assert.ok(error.details.remedy);
            assert.equal(kinds.length, 4, "failed calls never invalidate");
          } finally {
            await client.close();
          }
        },
      );
    } finally {
      if (originalOwner) process.env.BRAIN_OWNER_EMAIL = originalOwner;
      else delete process.env.BRAIN_OWNER_EMAIL;
      if (originalEmbeddings)
        process.env.BRAIN_QUERY_EMBEDDINGS = originalEmbeddings;
      else delete process.env.BRAIN_QUERY_EMBEDDINGS;
      if (originalTasks) process.env.TASKS_ENABLED = originalTasks;
      else delete process.env.TASKS_ENABLED;
      for (const table of [
        "brain_task_events",
        "brain_tasks",
        "brain_task_settings",
        "brain_task_extraction_rejections",
        "brain_pages",
      ])
        await pool.query(`DELETE FROM ${table} WHERE owner_id = $1`, [ownerId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
      await pool.query("DELETE FROM brain_agents WHERE owner_id = $1", [
        ownerId,
      ]);
      await pool.end();
    }
  },
);
