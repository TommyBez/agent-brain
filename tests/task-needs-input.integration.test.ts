import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal } from "../lib/auth-principal";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import { ownerActor, resolveActor } from "../lib/tasks/actors";
import {
  claimTask,
  completeTask,
  releaseTask,
  reportTask,
} from "../lib/tasks/claims";
import { addTaskDependency } from "../lib/tasks/dependencies";
import { setTasksEnabled } from "../lib/tasks/feature";
import { answerTask, blockTask } from "../lib/tasks/owner";
import { createTask, readTask } from "../lib/tasks/service";

// §6.2: from needs_input the holder may only release the task. Completing it
// would drop the owner's open question, so complete_task waits for the answer.

const code =
  (expected: string, check?: (details: Record<string, unknown>) => void) =>
  (error: unknown) => {
    if (!(error instanceof BrainError) || error.code !== expected) return false;
    check?.((error.details ?? {}) as Record<string, unknown>);
    return true;
  };

const tools = (actions: { kind: string; tool?: string }[]) =>
  actions.flatMap((action) =>
    action.kind === "tool" && action.tool ? [action.tool] : [],
  );

test(
  "needs_input: the holder cannot complete until the owner answers",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 120_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `task-needs-input-${ownerId}@example.invalid`;
    const suffix = ownerId.slice(0, 8);
    const saved = {
      owner: process.env.BRAIN_OWNER_EMAIL,
      embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
    };
    process.env.BRAIN_OWNER_EMAIL = [saved.owner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Needs Input Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    const principal: Principal = {
      ownerId,
      scopes: ["brain:read", "brain:write"],
      kind: "oauth",
      clientId: `claude-code-${suffix}`,
    };
    try {
      const owner = await ownerActor(ownerId);
      await setTasksEnabled(owner, true);
      const claude = await resolveActor(ownerId, principal);
      const report = {
        summary: "Draft sent.",
        criteria: [
          {
            index: 0,
            status: "met" as const,
            evidence: "The client confirmed receipt.",
            verification: "observed" as const,
          },
        ],
      };
      const taskRow = async (id: string) =>
        (
          await pool.query(
            `SELECT status, claimed_by_agent_id, lease_id IS NOT NULL AS leased,
                    input_requested_at IS NOT NULL AS asked, completion, completed_lease_hash
               FROM brain_tasks WHERE owner_id = $1 AND id = $2`,
            [ownerId, id],
          )
        ).rows[0];
      const completedEvents = async (id: string) =>
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM brain_task_events WHERE owner_id = $1 AND task_id = $2 AND action = 'completed'",
            [ownerId, id],
          )
        ).rows[0].n;

      await t.test(
        "complete_task is refused while the question is open",
        async () => {
          const task = await createTask(owner, {
            title: `Send the draft ${suffix}`,
            acceptanceCriteria: ["The client has the draft"],
          });
          const dependent = await createTask(owner, {
            title: `Follow up with the client ${suffix}`,
          });
          await addTaskDependency(owner, dependent.task.ref, task.task.ref);
          await blockTask(owner, dependent.task.ref, { reason: "dependency" });
          const claimed = await claimTask(claude, { ref: task.task.ref });
          const asked = await reportTask(claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            note: "Waiting for a go-ahead",
            question: { prompt: "Send the draft to the client?" },
          });
          assert.equal(asked.status, "needs_input");

          const waiting = await readTask(claude, { ref: task.task.ref });
          assert.equal(waiting.you.holder, true);
          const waitingTools = tools(waiting.nextActions);
          assert.deepEqual(waitingTools, ["read_task", "release_task"]);
          assert.ok(
            waiting.nextActions.some(
              (action) =>
                action.kind === "owner_action" &&
                action.url.endsWith(`/tasks/${task.task.ref}#answer`),
            ),
          );

          await assert.rejects(
            completeTask(claude, {
              ref: task.task.ref,
              leaseId: claimed.leaseId,
              ...report,
            }),
            code("INVALID_TRANSITION", (details) => {
              assert.equal(details.ref, task.task.ref);
              assert.equal(details.status, "needs_input");
              assert.match(String(details.remedy), /release_task/);
            }),
          );
          const after = await taskRow(task.task.id);
          assert.equal(after.status, "needs_input");
          assert.equal(after.claimed_by_agent_id, claude.agentId);
          assert.equal(after.leased, true);
          assert.equal(after.asked, true);
          assert.equal(after.completion, null);
          assert.equal(after.completed_lease_hash, null);
          assert.equal(await completedEvents(task.task.id), 0);
          assert.equal(
            (await readTask(owner, { ref: dependent.task.ref })).task.status,
            "blocked",
            "a refused completion never unblocks dependents",
          );

          // The owner can still answer, and the holder completes once resumed.
          await answerTask(owner, task.task.ref, { answer: "Yes, send it" });
          const resumed = await readTask(claude, { ref: task.task.ref });
          assert.equal(resumed.task.status, "in_progress");
          assert.deepEqual(tools(resumed.nextActions), [
            "report_task",
            "complete_task",
          ]);
          const done = await completeTask(claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            ...report,
          });
          assert.equal(done.status, "done");
          assert.equal(done.replayed, false);
          assert.equal(await completedEvents(task.task.id), 1);
          assert.equal(
            (await readTask(owner, { ref: dependent.task.ref })).task.status,
            "ready",
          );
        },
      );

      await t.test("release_task still works from needs_input", async () => {
        const task = await createTask(owner, {
          title: `Book the venue ${suffix}`,
        });
        const claimed = await claimTask(claude, { ref: task.task.ref });
        await reportTask(claude, {
          ref: task.task.ref,
          leaseId: claimed.leaseId,
          note: "Need a date",
          question: { prompt: "Which date?" },
        });
        await assert.rejects(
          completeTask(claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            summary: "Booked.",
          }),
          code("INVALID_TRANSITION"),
        );
        const released = await releaseTask(claude, {
          ref: task.task.ref,
          leaseId: claimed.leaseId,
          reason: "handoff",
          note: "Handing off while the owner decides the date.",
        });
        assert.equal(released.status, "ready");
        const row = await taskRow(task.task.id);
        assert.equal(row.claimed_by_agent_id, null);
        assert.equal(row.completion, null);
        assert.equal(await completedEvents(task.task.id), 0);
      });
      await t.test(
        "the claim brief keeps owner and handoff notes behind many reports",
        async () => {
          const codex = await resolveActor(ownerId, {
            ...principal,
            clientId: `codex-${suffix}`,
          });
          const task = await createTask(owner, {
            title: `Translate the catalogue ${suffix}`,
          });
          const claimed = await claimTask(claude, { ref: task.task.ref });
          await reportTask(claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            note: "Two glossaries exist",
            question: { prompt: "Glossary A or B?" },
          });
          await answerTask(owner, task.task.ref, {
            answer: `Use glossary B ${suffix}`,
          });
          // More progress reports than the 50 most recent events used to hold.
          for (let i = 0; i < 60; i++)
            await reportTask(claude, {
              ref: task.task.ref,
              leaseId: claimed.leaseId,
              note: `Translated section ${i + 1}`,
            });
          await releaseTask(claude, {
            ref: task.task.ref,
            leaseId: claimed.leaseId,
            reason: "handoff",
            note: `Sections 1-60 done; the index is left ${suffix}`,
          });
          const next = await claimTask(codex, { ref: task.task.ref });
          assert.match(next.brief.markdown, new RegExp(`glossary B ${suffix}`));
          assert.match(
            next.brief.markdown,
            new RegExp(`the index is left ${suffix}`),
          );
          assert.match(next.brief.markdown, /Translated section 60/);
        },
      );
    } finally {
      for (const [key, value] of [
        ["BRAIN_OWNER_EMAIL", saved.owner],
        ["BRAIN_QUERY_EMBEDDINGS", saved.embeddings],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      for (const table of [
        "brain_task_events",
        "brain_task_links",
        "brain_tasks",
        "brain_task_settings",
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
