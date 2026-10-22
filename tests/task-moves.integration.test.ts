import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { delegateOptions } from "../components/tasks/delegates";
import type { Principal } from "../lib/auth-principal";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";
import { runDeterministicHygiene } from "../lib/maintenance/task-keeper/hygiene";
import {
  type Actor,
  ownerActor,
  resolveActor,
  setAgentDisabled,
  systemActor,
} from "../lib/tasks/actors";
import { claimTask, reportTask } from "../lib/tasks/claims";
import { setTasksEnabled } from "../lib/tasks/feature";
import { answerTask, delegateTask, forceReleaseTask } from "../lib/tasks/owner";
import { createTask } from "../lib/tasks/service";
import {
  acceptSuggestion,
  moveTask,
  runTaskOperation,
  saveTaskEdits,
} from "../lib/workspace/task-moves";
import {
  BOARD_COLUMN_LIMIT,
  NEEDS_YOU_SECTION_LIMIT,
  queryNeedsYou,
  querySuggestions,
  queryTaskBoard,
  queryTaskDetail,
  queryTaskFormChoices,
  queryTaskState,
} from "../lib/workspace/task-queries";

// The owner's actions check the task against what the screen showed. Claims,
// renewals and questions never move the version (§5), so these scenarios
// would all pass a version-only check.

const conflict = { code: "TASK_VERSION_CONFLICT" };

test(
  "owner actions never reach a claim, a question or a suggestion the owner did not see",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 240_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `task-moves-${ownerId}@example.invalid`;
    const suffix = ownerId.slice(0, 8);
    const original = {
      owner: process.env.BRAIN_OWNER_EMAIL,
      embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
    };
    process.env.BRAIN_OWNER_EMAIL = [original.owner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Moves Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    const oauth = (name: string): Principal => ({
      ownerId,
      scopes: ["brain:read", "brain:write"],
      kind: "oauth",
      clientId: `${name}-${suffix}`,
    });
    const owner = await ownerActor(ownerId);
    await setTasksEnabled(owner, true);
    const claude = await resolveActor(ownerId, oauth("claude-code"));
    const codex = await resolveActor(ownerId, oauth("codex"));
    const keeper = await systemActor(ownerId, "task_keeper");
    let seed = 0;
    const ownerTask = async (fields: Record<string, unknown> = {}) =>
      (await createTask(owner, { title: `Moves task ${++seed}`, ...fields }))
        .task;
    const expireLease = (number: number) =>
      pool.query(
        "UPDATE brain_tasks SET lease_expires_at = now() - interval '10 minutes' WHERE owner_id = $1 AND number = $2",
        [ownerId, number],
      );
    const claimedTask = async (holder: Actor) => {
      const task = await ownerTask();
      const claim = await claimTask(holder, { ref: task.ref });
      return { task, leaseId: claim.leaseId as string };
    };
    const stillHolds = async (holder: Actor, ref: string, leaseId: string) => {
      await reportTask(holder, { ref, leaseId, note: "Still on it." });
      const state = await queryTaskState(ownerId, ref);
      assert.equal(state.status, "in_progress");
      assert.equal(state.holder, holder.agent.label);
    };
    const staleClaimSuggestion = async (taskId: string) => {
      await runDeterministicHygiene(ownerId, keeper.agentId);
      const suggestion = (await querySuggestions(ownerId, taskId)).find(
        (item) => item.kind === "stale_claim",
      );
      assert.ok(suggestion, "the nightly run opened a stale claim suggestion");
      return suggestion;
    };
    const seenOf = (
      suggestion: Awaited<ReturnType<typeof querySuggestions>>[number],
    ) => ({
      version: suggestion.task.version,
      status: suggestion.task.status,
      claimCount: suggestion.task.claimCount,
    });
    const suggestionStatus = async (id: string) =>
      (
        await pool.query(
          "SELECT status FROM brain_task_suggestions WHERE owner_id = $1 AND id = $2",
          [ownerId, id],
        )
      ).rows[0].status as string;

    try {
      await t.test(
        "a board move refuses a claim taken over since the board loaded",
        async () => {
          const { task } = await claimedTask(claude);
          await expireLease(task.number);
          const card = (
            await queryTaskBoard(ownerId, { projectId: "", query: "" })
          ).tasks.find((row) => row.ref === task.ref);
          assert.ok(card);
          assert.equal(card.claimCount, 1);
          // Codex takes the expired lease over: status and version stay.
          const takeover = await claimTask(codex, { ref: task.ref });
          const state = await queryTaskState(ownerId, task.ref);
          assert.deepEqual(
            [state.status, state.version],
            [card.status, card.version],
          );
          await assert.rejects(
            moveTask(owner, task.ref, card.status, "ready", {
              expectedVersion: card.version,
              claimCount: card.claimCount,
            }),
            (error: Error & { code?: string }) => {
              assert.equal(error.code, conflict.code);
              assert.match(error.message, /changed since the board loaded/);
              assert.ok(
                error.message.includes(`${codex.agent.label} claimed it`),
              );
              return true;
            },
          );
          await stillHolds(codex, task.ref, takeover.leaseId);
          // A board that shows the current claim moves it.
          const moved = await moveTask(
            owner,
            task.ref,
            "in_progress",
            "ready",
            {
              expectedVersion: state.version,
              claimCount: 2,
            },
          );
          assert.equal(moved.status, "ready");
        },
      );

      await t.test(
        "Release and Revoke refuse a claim newer than the screen",
        async () => {
          const { task } = await claimedTask(claude);
          await expireLease(task.number);
          const { task: shown } = await queryTaskDetail(ownerId, task.ref);
          const takeover = await claimTask(codex, { ref: task.ref });
          await assert.rejects(
            runTaskOperation(owner, task.ref, "release", {
              expectedVersion: shown.version,
              claimCount: shown.claimCount,
            }),
            conflict,
          );
          await stillHolds(codex, task.ref, takeover.leaseId);
        },
      );

      await t.test("an answer binds to the question it answers", async () => {
        const { task, leaseId } = await claimedTask(claude);
        await reportTask(claude, {
          ref: task.ref,
          leaseId,
          note: "Need a format.",
          question: { prompt: "Which format?", choices: ["PDF", "Slides"] },
        });
        const first = (await queryTaskDetail(ownerId, task.ref)).task;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await reportTask(claude, {
          ref: task.ref,
          leaseId,
          note: "And a deadline.",
          question: {
            prompt: "Which deadline?",
            choices: ["Friday", "Monday"],
          },
        });
        const second = (await queryTaskDetail(ownerId, task.ref)).task;
        assert.equal(
          second.version,
          first.version,
          "questions keep the version",
        );
        assert.notEqual(second.inputRequestedAt, first.inputRequestedAt);
        await assert.rejects(
          runTaskOperation(owner, task.ref, "answer", {
            expectedVersion: first.version,
            inputRequestedAt: first.inputRequestedAt,
            choice: "PDF",
          }),
          (error: Error & { code?: string }) => {
            assert.equal(error.code, conflict.code);
            assert.match(error.message, /new question/);
            return true;
          },
        );
        assert.equal(
          (await queryTaskState(ownerId, task.ref)).status,
          "needs_input",
        );
        const answered = await runTaskOperation(owner, task.ref, "answer", {
          expectedVersion: second.version,
          inputRequestedAt: second.inputRequestedAt,
          choice: "Friday",
        });
        assert.equal(answered.status, "in_progress", "the holder resumes");
      });

      await t.test(
        "a stale claim suggestion applies only to the expired claim it saw",
        async () => {
          // The holder renews after the nightly run.
          const renewed = await claimedTask(claude);
          await expireLease(renewed.task.number);
          const first = await staleClaimSuggestion(renewed.task.id);
          await reportTask(claude, {
            ref: renewed.task.ref,
            leaseId: renewed.leaseId,
            note: "Back on it.",
          });
          await assert.rejects(
            acceptSuggestion(owner, first.id, seenOf(first)),
            (error: Error & { code?: string }) => {
              assert.equal(error.code, conflict.code);
              assert.match(error.message, /renewed/);
              return true;
            },
          );
          assert.equal(await suggestionStatus(first.id), "expired");
          await stillHolds(claude, renewed.task.ref, renewed.leaseId);

          // Another agent takes the expired lease over.
          const taken = await claimedTask(claude);
          await expireLease(taken.task.number);
          const second = await staleClaimSuggestion(taken.task.id);
          const takeover = await claimTask(codex, { ref: taken.task.ref });
          await assert.rejects(
            acceptSuggestion(owner, second.id, seenOf(second)),
            (error: Error & { code?: string }) => {
              assert.equal(error.code, conflict.code);
              assert.match(error.message, /taken over/);
              return true;
            },
          );
          assert.equal(await suggestionStatus(second.id), "expired");
          await stillHolds(codex, taken.task.ref, takeover.leaseId);

          // Still expired, same holder: accepting releases it.
          const stale = await claimedTask(claude);
          await expireLease(stale.task.number);
          const third = await staleClaimSuggestion(stale.task.id);
          assert.deepEqual(
            await acceptSuggestion(owner, third.id, seenOf(third)),
            { ref: stale.task.ref, ran: "release" },
          );
          assert.equal(await suggestionStatus(third.id), "accepted");
          assert.equal(
            (await queryTaskState(ownerId, stale.task.ref)).status,
            "ready",
          );
          await assert.rejects(
            reportTask(claude, {
              ref: stale.task.ref,
              leaseId: stale.leaseId,
              note: "Still here?",
            }),
            { code: "LEASE_LOST" },
          );
        },
      );

      await t.test(
        "owner powers check the claim, the lease and the question again under their row lock",
        async () => {
          // A takeover committed after the early check, before the lock.
          const { task } = await claimedTask(claude);
          await expireLease(task.number);
          const shown = (await queryTaskDetail(ownerId, task.ref)).task;
          const takeover = await claimTask(codex, { ref: task.ref });
          await assert.rejects(
            forceReleaseTask(owner, task.ref, {
              expectedVersion: shown.version,
              expectedClaimCount: shown.claimCount,
            }),
            (
              error: Error & { code?: string; details?: { change?: string } },
            ) => {
              assert.equal(error.code, conflict.code);
              assert.match(error.message, /claim changed/);
              assert.equal(error.details?.change, "claim");
              return true;
            },
          );
          await stillHolds(codex, task.ref, takeover.leaseId);

          // A renewal moves only the lease expiry.
          const renewed = await claimedTask(claude);
          await expireLease(renewed.task.number);
          const lease = async () =>
            (
              await pool.query(
                "SELECT version, claim_count, lease_expires_at FROM brain_tasks WHERE owner_id = $1 AND id = $2",
                [ownerId, renewed.task.id],
              )
            ).rows[0];
          const expired = await lease();
          await reportTask(claude, {
            ref: renewed.task.ref,
            leaseId: renewed.leaseId,
            note: "Back on it.",
          });
          await assert.rejects(
            forceReleaseTask(owner, renewed.task.ref, {
              expectedVersion: expired.version,
              expectedClaimCount: expired.claim_count,
              expectedLeaseExpiresAt: expired.lease_expires_at.toISOString(),
            }),
            conflict,
          );
          await stillHolds(claude, renewed.task.ref, renewed.leaseId);
          const live = await lease();
          const released = await forceReleaseTask(owner, renewed.task.ref, {
            expectedVersion: live.version,
            expectedClaimCount: live.claim_count,
            expectedLeaseExpiresAt: live.lease_expires_at.toISOString(),
          });
          assert.equal(released.status, "ready", "a matching fence runs");

          // A second question asked after the screen loaded.
          const asked = await claimedTask(claude);
          await reportTask(claude, {
            ref: asked.task.ref,
            leaseId: asked.leaseId,
            note: "Need a format.",
            question: { prompt: "Which format?" },
          });
          const first = (await queryTaskDetail(ownerId, asked.task.ref)).task;
          await new Promise((resolve) => setTimeout(resolve, 5));
          await reportTask(claude, {
            ref: asked.task.ref,
            leaseId: asked.leaseId,
            note: "And a deadline.",
            question: { prompt: "Which deadline?" },
          });
          await assert.rejects(
            answerTask(owner, asked.task.ref, {
              expectedVersion: first.version,
              expectedInputRequestedAt: first.inputRequestedAt,
              answer: "PDF",
            }),
            (error: Error & { code?: string }) => {
              assert.equal(error.code, conflict.code);
              assert.match(error.message, /new question/);
              return true;
            },
          );
          assert.equal(
            (await queryTaskState(ownerId, asked.task.ref)).status,
            "needs_input",
          );
        },
      );

      await t.test(
        "accepting a suggestion refuses a task claimed since the card was shown",
        async () => {
          const task = await ownerTask();
          await pool.query(
            `INSERT INTO brain_task_suggestions (owner_id, task_id, kind, citations, confidence, policy_version, dedupe_key, payload, created_by_agent_id)
             VALUES ($1, $2, 'may_be_done', '[]'::jsonb, 0.9, 'task-keeper-v1', $3, $4::jsonb, $5)`,
            [
              ownerId,
              task.id,
              `moves-done-${suffix}`,
              JSON.stringify({ action: "close", state: "done" }),
              keeper.agentId,
            ],
          );
          const [card] = await querySuggestions(ownerId, task.id);
          assert.equal(card.task.status, "ready");
          const claim = await claimTask(claude, { ref: task.ref });
          await assert.rejects(
            acceptSuggestion(owner, card.id, seenOf(card)),
            conflict,
          );
          assert.equal(
            await suggestionStatus(card.id),
            "open",
            "the suggestion may still apply once the owner sees the claim",
          );
          await stillHolds(claude, task.ref, claim.leaseId);
          const [fresh] = await querySuggestions(ownerId, task.id);
          assert.deepEqual(
            await acceptSuggestion(owner, fresh.id, seenOf(fresh)),
            { ref: task.ref, ran: "close" },
          );
          assert.equal(
            (await queryTaskState(ownerId, task.ref)).status,
            "done",
          );
        },
      );

      await t.test(
        "an edit fails before writing when its delegate was disabled, and the delegate stays visible",
        async () => {
          const task = await ownerTask();
          const delegated = await ownerTask();
          await delegateTask(owner, delegated.ref, {
            agentId: codex.agentId,
          });
          await setAgentDisabled(ownerId, codex.agentId, true);
          await assert.rejects(
            saveTaskEdits(
              owner,
              task.ref,
              task.version,
              { title: `Renamed ${suffix}` },
              { agentId: codex.agentId },
            ),
            { code: "AGENT_NOT_FOUND" },
          );
          const detail = await queryTaskDetail(ownerId, task.ref);
          assert.equal(
            detail.task.version,
            task.version,
            "nothing was written",
          );
          assert.equal(detail.task.title.value, task.title.value);

          const shown = (await queryTaskDetail(ownerId, delegated.ref)).task;
          const choices = await queryTaskFormChoices(ownerId);
          assert.ok(
            !choices.agents.some((agent) => agent.id === codex.agentId),
          );
          const options = delegateOptions(choices.agents, {
            id: shown.delegateId,
            label: shown.delegate?.label ?? null,
          });
          assert.deepEqual(
            options.find((option) => option.value === codex.agentId),
            {
              value: codex.agentId,
              label: `${codex.agent.label} (disabled)`,
              unavailable: true,
            },
          );
          await setAgentDisabled(ownerId, codex.agentId, false);
        },
      );

      await t.test(
        "long columns and sections report their full count",
        async () => {
          const project = await brain.write(
            ownerId,
            {
              title: `Crowded ${suffix}`,
              type: "project",
              markdown: "Many tasks.",
              expectedVersion: 0,
            },
            { actorAgentId: owner.agentId },
          );
          const many =
            Math.max(BOARD_COLUMN_LIMIT, NEEDS_YOU_SECTION_LIMIT) + 1;
          for (let index = 0; index < many; index++)
            await ownerTask({ projectRef: project.id, priority: 2 });
          const board = await queryTaskBoard(ownerId, {
            projectId: project.id,
            query: "",
          });
          assert.equal(board.totals.ready, many);
          assert.equal(board.tasks.length, BOARD_COLUMN_LIMIT);

          const asking = await claimedTask(claude);
          await reportTask(claude, {
            ref: asking.task.ref,
            leaseId: asking.leaseId,
            note: "One question.",
            question: { prompt: "Low priority question?" },
          });
          await pool.query(
            "UPDATE brain_tasks SET priority = 3 WHERE owner_id = $1 AND number = $2",
            [ownerId, asking.task.number],
          );
          await pool.query(
            `UPDATE brain_tasks SET status = 'triage', approved_at = NULL, approved_by_agent_id = NULL
             WHERE owner_id = $1 AND project_page_id = $2`,
            [ownerId, project.id],
          );
          const data = await queryNeedsYou(ownerId);
          const shownTriage = data.triage.reduce(
            (sum, batch) => sum + batch.tasks.length,
            0,
          );
          assert.equal(data.totals.triage, many);
          assert.equal(shownTriage, NEEDS_YOU_SECTION_LIMIT);
          assert.ok(
            data.questions.some(
              (question) => question.task.ref === asking.task.ref,
            ),
            "a long triage never hides a question",
          );
        },
      );
    } finally {
      if (original.owner) process.env.BRAIN_OWNER_EMAIL = original.owner;
      else delete process.env.BRAIN_OWNER_EMAIL;
      if (original.embeddings)
        process.env.BRAIN_QUERY_EMBEDDINGS = original.embeddings;
      else delete process.env.BRAIN_QUERY_EMBEDDINGS;
      for (const table of [
        "brain_task_events",
        "brain_task_suggestions",
        "brain_tasks",
        "brain_task_settings",
        "brain_task_extraction_rejections",
        "brain_pages",
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
