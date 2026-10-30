import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";
import { ownerActor, systemActor } from "../lib/tasks/actors";

const violates =
  (constraint: string, sqlState = "23514") =>
  (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === sqlState &&
    "constraint" in error &&
    error.constraint === constraint;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test(
  "task migrations: constraints, generated search and referential actions",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const pool = getPool();
    const ownerId = `tasks-schema-${randomUUID()}`;
    const otherOwner = `tasks-schema-${randomUUID()}`;
    let number = 0;
    try {
      const owner = await ownerActor(ownerId);
      const keeper = await systemActor(ownerId, "task_keeper");
      const foreign = await ownerActor(otherOwner);
      const insertTask = async (
        fields: Record<string, unknown> = {},
        db = pool,
      ): Promise<{ id: string; number: number }> => {
        const values: Record<string, unknown> = {
          owner_id: ownerId,
          number: ++number,
          title: `Task ${number}`,
          origin: "owner_ui",
          created_by_agent_id: owner.agentId,
          ...fields,
        };
        const columns = Object.keys(values);
        const { rows } = await db.query(
          `INSERT INTO brain_tasks (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")}) RETURNING id, number`,
          Object.values(values),
        );
        return rows[0];
      };

      await t.test(
        "a valid task is searchable by title, criteria and description",
        async () => {
          const task = await insertTask({
            title: "Prepare clinical report",
            description: "Draft for the steering committee.",
            acceptance_criteria: ["Monitoring section reviewed"],
          });
          const { rows } = await pool.query(
            `SELECT status, priority, review_policy, version, due_kind,
               search_document @@ to_tsquery('simple', 'clinical & monitoring & steering') AS found,
               ts_rank(search_document, to_tsquery('simple', 'clinical')) > ts_rank(search_document, to_tsquery('simple', 'steering')) AS title_weighs_more
             FROM brain_tasks WHERE id = $1`,
            [task.id],
          );
          assert.deepEqual(rows[0], {
            status: "triage",
            priority: 2,
            review_policy: "auto",
            version: 1,
            due_kind: "unset",
            found: true,
            title_weighs_more: true,
          });
          await assert.rejects(
            insertTask({ number: task.number }),
            violates("brain_tasks_owner_id_number_key", "23505"),
          );
        },
      );

      await t.test("status, lease, review and due CHECKs", async () => {
        const holder = { claimed_by_agent_id: keeper.agentId };
        const cases: [Record<string, unknown>, string][] = [
          [{ status: "blocked" }, "brain_tasks_blocked_reason_check"],
          [
            { status: "ready", blocked_reason: "external" },
            "brain_tasks_blocked_reason_check",
          ],
          [{ status: "reconciliation" }, "brain_tasks_status_check"],
          [{ lease_id: randomUUID() }, "brain_tasks_claim_check"],
          [
            { ...holder, lease_id: randomUUID(), status: "ready" },
            "brain_tasks_lease_check",
          ],
          [
            {
              ...holder,
              lease_id: randomUUID(),
              status: "in_progress",
              claimed_at: new Date(),
            },
            "brain_tasks_lease_check",
          ],
          [{ status: "needs_input" }, "brain_tasks_lease_check"],
          [
            { expected_output: "decision", review_policy: "auto" },
            "brain_tasks_review_policy_check",
          ],
          [{ due_kind: "date" }, "brain_tasks_due_date_check"],
          [{ due_kind: "event" }, "brain_tasks_due_event_check"],
          [
            { due_kind: "hard", due_on: "2026-10-16", due_at: new Date() },
            "brain_tasks_due_hard_check",
          ],
          [{ due_on: "2026-10-16" }, "brain_tasks_due_unset_check"],
          [{ priority: 4 }, "brain_tasks_priority_check"],
          [{ origin: "imported" }, "brain_tasks_origin_check"],
          [
            { acceptance_criteria: ["x".repeat(501)] },
            "brain_tasks_acceptance_criteria_check",
          ],
          [
            { acceptance_criteria: Array(21).fill("criterion") },
            "brain_tasks_acceptance_criteria_check",
          ],
          [{ idempotency_key: "create-001" }, "brain_tasks_idempotency_check"],
          [{ approved_at: new Date() }, "brain_tasks_approval_check"],
          [
            { completed_lease_hash: "not-a-hash" },
            "brain_tasks_completed_lease_hash_check",
          ],
          [{ extraction_fingerprint: "ABC" }, "brain_tasks_extraction_check"],
        ];
        for (const [fields, constraint] of cases)
          await assert.rejects(
            insertTask(fields),
            violates(constraint),
            constraint,
          );

        const leased = await insertTask({
          ...holder,
          lease_id: randomUUID(),
          status: "in_progress",
          claimed_at: new Date(),
          lease_expires_at: new Date(Date.now() + 30 * 60_000),
        });
        // Waiting for the owner keeps the lease but suspends its expiry.
        await pool.query(
          `UPDATE brain_tasks SET status = 'needs_input', lease_expires_at = NULL, input_requested_at = now() WHERE id = $1`,
          [leased.id],
        );
        await insertTask({
          expected_output: "external_action",
          review_policy: "owner",
          due_kind: "event",
          due_text: "prossima riunione",
          idempotency_key: "create-002",
          idempotency_fingerprint: sha("payload"),
        });
        await assert.rejects(
          insertTask({
            idempotency_key: "create-002",
            idempotency_fingerprint: sha("other"),
          }),
          violates("brain_tasks_idempotency_idx", "23505"),
        );
        // The same key is free for another creator.
        await insertTask({
          created_by_agent_id: keeper.agentId,
          idempotency_key: "create-002",
          idempotency_fingerprint: sha("payload"),
        });
        await assert.rejects(
          insertTask({ created_by_agent_id: foreign.agentId }),
          violates("brain_tasks_owner_id_created_by_agent_id_fkey", "23503"),
        );
      });

      await t.test(
        "events, parties, dependencies, suggestions and settings",
        async () => {
          const task = await insertTask();
          const other = await insertTask();
          const event = await pool.query(
            `INSERT INTO brain_task_events (owner_id, task_id, actor_agent_id, action, to_status)
             VALUES ($1, $2, $3, 'created', 'triage') RETURNING tx::text AS tx, payload`,
            [ownerId, task.id, owner.agentId],
          );
          assert.match(event.rows[0].tx, /^\d+$/);
          assert.deepEqual(event.rows[0].payload, {});
          await assert.rejects(
            pool.query(
              `INSERT INTO brain_task_events (owner_id, task_id, actor_agent_id, action) VALUES ($1, NULL, $2, 'note')`,
              [ownerId, owner.agentId],
            ),
            violates("brain_task_events_action_check"),
          );
          await assert.rejects(
            pool.query(
              `INSERT INTO brain_task_events (owner_id, task_id, actor_agent_id, action) VALUES ($1, $2, $3, 'purged')`,
              [ownerId, task.id, owner.agentId],
            ),
            violates("brain_task_events_action_check"),
          );
          await pool.query(
            `INSERT INTO brain_task_events (owner_id, task_id, actor_agent_id, action, payload) VALUES ($1, NULL, $2, 'purged', '{"number": 1}')`,
            [ownerId, owner.agentId],
          );

          const party = (fields: Record<string, unknown>) =>
            pool.query(
              `INSERT INTO brain_task_parties (owner_id, task_id, role, kind, agent_id, person_page_id, group_label, created_by_agent_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                ownerId,
                task.id,
                fields.role ?? "lead",
                fields.kind,
                fields.agent_id ?? null,
                fields.person_page_id ?? null,
                fields.group_label ?? null,
                owner.agentId,
              ],
            );
          await party({ kind: "group", group_label: "Team JSB" });
          await assert.rejects(
            party({ kind: "group", group_label: "Team JSB" }),
            violates("brain_task_parties_member_key", "23505"),
          );
          await assert.rejects(
            party({ kind: "person", group_label: "Dr. Damato" }),
            violates("brain_task_parties_member_check"),
          );
          await assert.rejects(
            party({ kind: "agent" }),
            violates("brain_task_parties_member_check"),
          );
          await party({
            kind: "owner",
            agent_id: owner.agentId,
            role: "support",
          });

          await assert.rejects(
            pool.query(
              `INSERT INTO brain_task_dependencies (owner_id, task_id, depends_on_task_id, created_by_agent_id) VALUES ($1, $2, $2, $3)`,
              [ownerId, task.id, owner.agentId],
            ),
            violates("brain_task_dependencies_check"),
          );
          await pool.query(
            `INSERT INTO brain_task_dependencies (owner_id, task_id, depends_on_task_id, created_by_agent_id) VALUES ($1, $2, $3, $4)`,
            [ownerId, task.id, other.id, owner.agentId],
          );

          const suggestion = () =>
            pool.query(
              `INSERT INTO brain_task_suggestions (owner_id, task_id, related_task_id, kind, policy_version, dedupe_key, created_by_agent_id)
               VALUES ($1, $2, $3, 'duplicate', 'task-keeper-v1', $4, $5)`,
              [
                ownerId,
                task.id,
                other.id,
                `duplicate:${task.id}`,
                keeper.agentId,
              ],
            );
          await suggestion();
          await assert.rejects(
            suggestion(),
            violates("brain_task_suggestions_owner_id_dedupe_key_key", "23505"),
          );
          await assert.rejects(
            pool.query(
              `INSERT INTO brain_task_suggestions (owner_id, task_id, kind, policy_version, dedupe_key, created_by_agent_id)
               VALUES ($1, $2, 'harvest_candidate', 'task-keeper-v1', 'x', $3)`,
              [ownerId, task.id, keeper.agentId],
            ),
            violates("brain_task_suggestions_kind_check"),
          );
          await assert.rejects(
            pool.query(
              `INSERT INTO brain_task_settings (owner_id, saved_views) VALUES ($1, '{}'::jsonb)`,
              [ownerId],
            ),
            violates("brain_task_settings_saved_views_check"),
          );
          const settings = await pool.query(
            `INSERT INTO brain_task_settings (owner_id) VALUES ($1) RETURNING paused_project_ids, keeper_excluded_page_ids, saved_views`,
            [ownerId],
          );
          assert.deepEqual(settings.rows[0], {
            paused_project_ids: [],
            keeper_excluded_page_ids: [],
            saved_views: [],
          });

          // Purge: the task's own history goes, the purged marker stays.
          await pool.query("DELETE FROM brain_tasks WHERE id = $1", [task.id]);
          const left = await pool.query(
            `SELECT action FROM brain_task_events WHERE owner_id = $1`,
            [ownerId],
          );
          assert.deepEqual(
            left.rows.map((row) => row.action),
            ["purged"],
          );
          for (const table of [
            "brain_task_parties",
            "brain_task_dependencies",
            "brain_task_suggestions",
          ])
            assert.equal(
              (
                await pool.query(
                  `SELECT count(*)::int AS count FROM ${table} WHERE owner_id = $1`,
                  [ownerId],
                )
              ).rows[0].count,
              0,
              table,
            );
        },
      );

      await t.test(
        "deleted parents, projects and recurrences clear only their reference",
        async () => {
          const project = await brain.write(ownerId, {
            title: "Schema project",
            type: "project",
            markdown: "Holds tasks.",
            expectedVersion: 0,
          });
          const recurrence = await pool.query(
            `INSERT INTO brain_task_recurrences (owner_id, kind, template, rrule, project_page_id, created_by_agent_id)
             VALUES ($1, 'meeting', '{"title": "Weekly JSB"}', 'FREQ=WEEKLY;BYDAY=TH', $2, $3) RETURNING id`,
            [ownerId, project.id, owner.agentId],
          );
          const recurrenceId = recurrence.rows[0].id;
          const parent = await insertTask({ project_page_id: project.id });
          const child = await insertTask({
            parent_task_id: parent.id,
            project_page_id: project.id,
            origin: "recurrence",
            status: "ready",
            recurrence_id: recurrenceId,
            occurrence_on: "2026-10-22",
          });
          await assert.rejects(
            insertTask({
              recurrence_id: recurrenceId,
              occurrence_on: "2026-10-22",
            }),
            violates("brain_tasks_recurrence_occurrence_key", "23505"),
          );
          await assert.rejects(
            insertTask({ recurrence_id: recurrenceId }),
            violates("brain_tasks_recurrence_check"),
          );
          await assert.rejects(
            pool.query(
              "UPDATE brain_tasks SET parent_task_id = id WHERE id = $1",
              [parent.id],
            ),
            violates("brain_tasks_parent_task_id_check"),
          );
          await pool.query("DELETE FROM brain_tasks WHERE id = $1", [
            parent.id,
          ]);
          await pool.query("DELETE FROM brain_task_recurrences WHERE id = $1", [
            recurrenceId,
          ]);
          await pool.query("DELETE FROM brain_pages WHERE id = $1", [
            project.id,
          ]);
          const { rows } = await pool.query(
            `SELECT owner_id, parent_task_id, project_page_id, recurrence_id, occurrence_on::text
             FROM brain_tasks WHERE id = $1`,
            [child.id],
          );
          assert.deepEqual(rows[0], {
            owner_id: ownerId,
            parent_task_id: null,
            project_page_id: null,
            recurrence_id: null,
            occurrence_on: "2026-10-22",
          });
        },
      );

      await t.test("existing tables accept the task phases", async () => {
        const job = await pool.query(
          `INSERT INTO brain_jobs (owner_id, kind, run_date) VALUES ($1, 'task_keeper', '2035-02-01'), ($1, 'task_links', '2035-02-01') RETURNING kind`,
          [ownerId],
        );
        assert.equal(job.rowCount, 2);
        await assert.rejects(
          pool.query(
            `INSERT INTO brain_jobs (owner_id, kind, run_date) VALUES ($1, 'reconciliation', '2035-02-01')`,
            [ownerId],
          ),
          violates("brain_jobs_kind_check"),
        );
        const spend = await pool.query(
          `INSERT INTO brain_consolidation_spend (owner_id, run_id, model, day) VALUES ($1, 'schema-test', 'jev', '2035-02-01') RETURNING purpose`,
          [ownerId],
        );
        assert.equal(spend.rows[0].purpose, "pages");
        await assert.rejects(
          pool.query(
            `INSERT INTO brain_consolidation_spend (owner_id, run_id, model, day, purpose) VALUES ($1, 'schema-test', 'jev', '2035-02-01', 'graph')`,
            [ownerId],
          ),
          violates("brain_consolidation_spend_purpose_check"),
        );
        await assert.rejects(
          pool.query(
            `INSERT INTO brain_agents (owner_id, kind, label) VALUES ($1, 'system', 'No key')`,
            [ownerId],
          ),
          violates("brain_agents_system_key_check"),
        );
        await assert.rejects(
          pool.query(
            `INSERT INTO brain_agents (owner_id, kind, label) VALUES ($1, 'owner', 'Second owner')`,
            [ownerId],
          ),
          violates("brain_agents_owner_kind_idx", "23505"),
        );
        await assert.rejects(
          pool.query(
            `INSERT INTO brain_agents (owner_id, kind, label, capabilities) VALUES ($1, 'agent', 'Bad caps', ARRAY[''])`,
            [ownerId],
          ),
          violates("brain_agents_capabilities_check"),
        );
      });
    } finally {
      await pool.query("DELETE FROM brain_jobs WHERE owner_id = $1", [ownerId]);
      await pool.query(
        "DELETE FROM brain_consolidation_spend WHERE owner_id = $1",
        [ownerId],
      );
      for (const table of [
        "brain_pages",
        "brain_tasks",
        "brain_task_events",
        "brain_task_recurrences",
        "brain_task_settings",
        "brain_agents",
      ])
        await pool.query(
          `DELETE FROM ${table} WHERE owner_id = ANY($1::text[])`,
          [[ownerId, otherOwner]],
        );
      await pool.end();
    }
  },
);
