import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Principal } from "../lib/auth-principal";
import * as brain from "../lib/brain/service";
import { getPool, transaction } from "../lib/db";
import { createBrainHandler } from "../lib/mcp/server";
import { ownerActor, resolveActor, systemActor } from "../lib/tasks/actors";
import { writeMachineLinks } from "../lib/tasks/links";
import { latestRetrievalState } from "../lib/tasks/retrieval";
import { createTask, readTask, updateTask } from "../lib/tasks/service";
import { decideTaskLink } from "../lib/tasks/suggestions";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

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

async function cleanupOwner(ownerId: string) {
  const pool = getPool();
  for (const table of [
    "brain_task_events",
    "brain_tasks",
    "brain_task_settings",
    "brain_task_extraction_rejections",
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

type Link = {
  page: { id: string };
  role: string;
  origin: string;
  status: string;
  evidence: Record<string, unknown>;
};
const find = (links: Link[], pageId: string, role?: string) =>
  links.filter(
    (link) => link.page.id === pageId && (!role || link.role === role),
  );

test(
  "conciliator: synchronous rule and retrieval links, brief and openTasks",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 180_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `task-links-sync-${ownerId}@example.invalid`;
    const env = {
      owner: process.env.BRAIN_OWNER_EMAIL,
      embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
      tasks: process.env.TASKS_ENABLED,
    };
    process.env.BRAIN_OWNER_EMAIL = [env.owner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    process.env.TASKS_ENABLED = "1";
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Links Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    try {
      const write = (input: Record<string, unknown>) =>
        brain.write(ownerId, { expectedVersion: 0, ...input });
      const project = await write({
        title: "Report studi clinici Farmalab",
        type: "project",
        markdown:
          "Progetto per il report trimestrale sugli studi clinici di Farmalab.",
      });
      const newsletter = await write({
        title: "Migrazione newsletter",
        type: "project",
        markdown: "Passaggio della newsletter a una nuova piattaforma.",
      });
      const decision = (title: string, target: string) =>
        write({
          title,
          type: "decision",
          markdown: `${title}: scelta adottata.`,
          links: [{ targetRef: target, type: "decided_in" }],
        });
      const format = await decision(
        "Formato del report trimestrale",
        project.id,
      );
      const deadline = await decision("Scadenza del report", project.id);
      const platform = await decision("Piattaforma Brevo", newsletter.id);
      const minutes = await write({
        title: "Verbale 15/10",
        type: "note",
        markdown: "Verbale della riunione del 15/10.",
      });
      const notes: Awaited<ReturnType<typeof write>>[] = [];
      for (const [index, text] of [
        "Studi clinici attivi di Farmalab e stato del report trimestrale",
        "Report trimestrale: modello e formato per Farmalab",
        "Studi clinici di fase II in corso",
        "Note sul report clinici",
        "Farmalab: contatti per i report",
        "Trimestrale vendite e report",
        "Concordato il formato con il cliente",
      ].entries())
        notes.push(
          await write({
            title: `Nota ${index + 1}`,
            type: "note",
            markdown: text,
          }),
        );
      const context = await write({
        title: "Dati arruolamento",
        type: "note",
        markdown: "Numero di pazienti arruolati per studio.",
      });
      const before = await knowledgeState(ownerId);
      const owner = await ownerActor(ownerId);
      const conciliator = await systemActor(ownerId, "consolidator");

      let reportRef = "";
      await t.test(
        "creation adds decided_in suggestions, mentions and five retrieval suggestions",
        async () => {
          const created = await createTask(owner, {
            title: "Preparare il report trimestrale sugli studi clinici",
            acceptanceCriteria: ["Formato concordato con Farmalab"],
            description: `Usare i dati di /pages/${minutes.slug} per il riepilogo.`,
            projectRef: project.id,
            contextPageRefs: [context.id],
          });
          reportRef = created.task.ref;
          const links = created.linked as Link[];
          for (const page of [format, deadline]) {
            const [rule] = find(links, page.id, "decision");
            assert.equal(rule.origin, "rule");
            assert.equal(rule.status, "suggested");
            assert.equal(rule.evidence.basis, "decided_in");
          }
          assert.equal(find(links, minutes.id)[0].status, "active");
          assert.equal(find(links, context.id)[0].origin, "owner");
          const retrieval = links.filter(
            (link) => link.evidence.basis === "retrieval",
          );
          assert.equal(retrieval.length, 5);
          for (const link of retrieval) {
            assert.equal(link.origin, "rule");
            assert.equal(link.status, "suggested");
            assert.equal(link.role, "context");
            assert.ok(
              ![
                project.id,
                format.id,
                deadline.id,
                minutes.id,
                context.id,
              ].includes(link.page.id),
            );
          }
          const { rows } = await pool.query(
            `SELECT DISTINCT l.created_by_agent_id FROM brain_task_links l JOIN brain_tasks t ON t.owner_id = l.owner_id AND t.id = l.task_id
           WHERE l.owner_id = $1 AND t.number = $2 AND l.origin = 'rule'`,
            [ownerId, Number(reportRef.slice(2))],
          );
          assert.deepEqual(rows, [
            { created_by_agent_id: conciliator.agentId },
          ]);
          const events = await pool.query(
            `SELECT e.payload FROM brain_task_events e WHERE e.owner_id = $1 AND e.task_id = $2
             AND e.action = 'links_changed' AND e.actor_agent_id = $3 ORDER BY e.id`,
            [ownerId, created.task.id, conciliator.agentId],
          );
          assert.deepEqual(
            events.rows.map((row) => row.payload.basis),
            ["rule", "retrieval"],
          );
          const state = await latestRetrievalState(
            pool,
            ownerId,
            created.task.id,
          );
          assert.equal(state?.mode, "sync");
          assert.equal(state?.embedding, "none");
        },
      );

      await t.test(
        "edits: unchanged digests skip retrieval, rules follow the project, decisions and rejections stay",
        async () => {
          const read = () => readTask(owner, { ref: reportRef });
          const retrievalRecords = async (taskId: string) =>
            (
              await pool.query(
                `SELECT count(*)::int AS n FROM brain_consolidation_records WHERE owner_id = $1 AND record_key = $2`,
                [ownerId, `task-link:retrieval:${taskId}`],
              )
            ).rows[0].n;
          let current = await read();
          const taskId = current.task.id;
          await decideTaskLink(owner, reportRef, {
            pageRef: deadline.id,
            role: "decision",
            decision: "active",
          });
          const rejected = (current.links as Link[]).find(
            (link) => link.evidence.basis === "retrieval",
          ) as Link;
          await decideTaskLink(owner, reportRef, {
            pageRef: rejected.page.id,
            role: "context",
            decision: "rejected",
          });
          const records = await retrievalRecords(taskId);
          current = await read();
          await updateTask(owner, {
            ref: reportRef,
            expectedVersion: current.task.version,
            patch: { projectRef: newsletter.id },
          });
          assert.equal(await retrievalRecords(taskId), records);
          current = await read();
          const links = current.links as Link[];
          assert.equal(
            find(links, platform.id, "decision")[0].status,
            "suggested",
          );
          assert.equal(find(links, format.id).length, 0); // retracted rows are not listed
          assert.equal(
            find(links, deadline.id, "decision")[0].status,
            "active",
          );
          const retracted = await pool.query(
            `SELECT status, evidence->>'retractedBecause' AS why FROM brain_task_links
           WHERE owner_id = $1 AND task_id = $2 AND page_id = $3`,
            [ownerId, taskId, format.id],
          );
          assert.deepEqual(retracted.rows, [
            { status: "retracted", why: "rule_no_longer_holds" },
          ]);

          await updateTask(owner, {
            ref: reportRef,
            expectedVersion: current.task.version,
            patch: {
              title:
                "Preparare il report trimestrale Farmalab sugli studi clinici attivi",
            },
          });
          assert.equal(await retrievalRecords(taskId), records + 1);
          const after = await pool.query(
            `SELECT status, origin FROM brain_task_links WHERE owner_id = $1 AND task_id = $2 AND page_id = $3`,
            [ownerId, taskId, rejected.page.id],
          );
          assert.deepEqual(after.rows, [
            { status: "rejected", origin: "rule" },
          ]);
        },
      );

      await t.test(
        "task keeper tasks get rule mention links, retracted when the mention goes",
        async () => {
          const keeper = await systemActor(ownerId, "task_keeper");
          const created = await createTask(keeper, {
            title: "Decidere come prosegue il monitoraggio",
            description: `Impegno dal verbale, vedi /pages/${notes[2].id} e /pages/${minutes.id}.`,
            origin: "extracted",
            extractionFingerprint: sha(`keeper-${ownerId}`),
            sourcePageRef: minutes.id,
          });
          const linked = created.linked as Link[];
          assert.deepEqual(
            find(linked, notes[2].id).map((link) => [
              link.role,
              link.origin,
              link.status,
              link.evidence.basis,
            ]),
            [["context", "rule", "active", "reference"]],
          );
          // The source page is already actively linked: no second, context row.
          assert.deepEqual(
            find(linked, minutes.id).map((link) => [link.role, link.origin]),
            [["source", "task_keeper"]],
          );
          const current = await readTask(owner, { ref: created.task.ref });
          await updateTask(owner, {
            ref: created.task.ref,
            expectedVersion: current.task.version,
            patch: { description: "Impegno dal verbale della riunione." },
          });
          const { rows } = await pool.query(
            `SELECT origin, status FROM brain_task_links WHERE owner_id = $1 AND task_id = $2 AND page_id = $3 AND role = 'context'`,
            [ownerId, created.task.id, notes[2].id],
          );
          assert.deepEqual(rows, [{ origin: "rule", status: "retracted" }]);
        },
      );

      await t.test(
        "the claim-time brief cites the project first and lists the links",
        async () => {
          const agent = await resolveActor(ownerId, {
            ownerId,
            scopes: ["brain:read", "brain:write"],
            kind: "oauth",
            clientId: `brief-${ownerId.slice(0, 8)}`,
          });
          const result = await readTask(agent, {
            ref: reportRef,
            includeBrief: true,
          });
          const brief = result.brief as NonNullable<typeof result.brief>;
          assert.equal(brief.citations[0].id, newsletter.id);
          assert.match(brief.markdown, /^# Linked pages/);
          assert.match(brief.markdown, /suggested/);
          assert.ok(brief.markdown.length <= 12_000);
          assert.ok(brief.gaps.some((gap) => gap.includes("unconfirmed")));
        },
      );

      await t.test(
        "read and context of project pages carry at most ten openTasks as operational state",
        async () => {
          const agent = await resolveActor(ownerId, {
            ownerId,
            scopes: ["brain:read", "brain:write"],
            kind: "oauth",
            clientId: `agent-${ownerId.slice(0, 8)}`,
          });
          await createTask(agent, {
            title: "Task di un agente sul progetto",
            origin: "owner_request",
            ownerQuote: "tieni traccia della migrazione",
            projectRef: newsletter.id,
            idempotencyKey: `open-${ownerId}`,
          });
          for (let index = 0; index < 10; index++)
            await createTask(owner, {
              title: `Passo ${index + 1} della migrazione`,
              projectRef: newsletter.id,
              priority: 3,
            });
          const principal: Principal = {
            ownerId,
            scopes: ["brain:read"],
            kind: "oauth",
            clientId: `reader-${ownerId.slice(0, 8)}`,
          };
          const handler = createBrainHandler(principal);
          const client = new Client(
            { name: "task-links-test", version: "1.0.0" },
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
            const call = async (
              name: string,
              args: Record<string, unknown>,
            ) => {
              const response = await client.callTool({ name, arguments: args });
              assert.equal(
                response.isError,
                undefined,
                JSON.stringify(response.content),
              );
              return (
                response.structuredContent as { data: Record<string, never> }
              ).data as Record<string, unknown>;
            };
            const read = await call("read", { ref: newsletter.id });
            const open = read.openTasks as {
              kind: string;
              note: string;
              more: boolean;
              tasks: {
                ref: string;
                title: { value: string; untrusted: boolean };
                status: string;
                claimedBy: unknown;
              }[];
            };
            assert.equal(open.kind, "operational_state");
            assert.equal(open.tasks.length, 10);
            assert.equal(open.more, true);
            assert.match(open.note, /not page knowledge/);
            assert.ok(!(read.markdown as string).includes("Passo 1"));
            const agentTask = open.tasks.find(
              (task) => task.title.value === "Task di un agente sul progetto",
            );
            assert.equal(agentTask?.title.untrusted, true);
            assert.ok(
              open.tasks.filter((task) => !task.title.untrusted).length >= 1,
            );
            assert.equal(
              (await call("read", { ref: minutes.id })).openTasks,
              undefined,
            );
            const bundle = await call("context", {
              query: "migrazione newsletter",
              refs: [newsletter.id],
            });
            const contextual = bundle.openTasks as {
              tasks: { project: string }[];
            };
            assert.ok(contextual.tasks.length <= 10);
            assert.ok(
              contextual.tasks.every(
                (task) => task.project === newsletter.slug,
              ),
            );
            assert.ok(!(bundle.markdown as string).includes("Passo 1"));
            process.env.TASKS_ENABLED = "0";
            assert.equal(
              (await call("read", { ref: newsletter.id })).openTasks,
              undefined,
            );
            process.env.TASKS_ENABLED = "1";
          } finally {
            await client.close();
          }
        },
      );

      await t.test(
        "the SQL guard never rewrites owner, agent, task keeper or rejected rows",
        async () => {
          const current = await readTask(owner, { ref: reportRef });
          const taskId = current.task.id;
          const rows = await pool.query(
            `SELECT page_id, role, origin, status, evidence, updated_at FROM brain_task_links
             WHERE owner_id = $1 AND task_id = $2 AND (origin IN ('owner', 'agent', 'task_keeper') OR status = 'rejected')
             ORDER BY page_id, role`,
            [ownerId, taskId],
          );
          assert.ok(rows.rows.length >= 2);
          const changes = await transaction((db) =>
            writeMachineLinks(
              db,
              ownerId,
              taskId,
              conciliator.agentId,
              rows.rows.map((row) => ({
                pageId: row.page_id,
                role: row.role,
                origin: "consolidator",
                status: "retracted",
                confidence: 0.01,
                evidence: { basis: "jev" },
              })),
            ),
          );
          assert.deepEqual(changes, []);
          const after = await pool.query(
            `SELECT page_id, role, origin, status, evidence, updated_at FROM brain_task_links
             WHERE owner_id = $1 AND task_id = $2 AND (origin IN ('owner', 'agent', 'task_keeper') OR status = 'rejected')
             ORDER BY page_id, role`,
            [ownerId, taskId],
          );
          assert.deepEqual(after.rows, rows.rows);
        },
      );

      await t.test(
        "the conciliator never writes pages, typed links or revisions",
        async () => {
          assert.deepEqual(await knowledgeState(ownerId), before);
          const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM brain_pages WHERE owner_id = $1 AND markdown LIKE '%Passo 1 della migrazione%'`,
            [ownerId],
          );
          assert.equal(rows[0].n, 0);
        },
      );
    } finally {
      if (env.owner === undefined) delete process.env.BRAIN_OWNER_EMAIL;
      else process.env.BRAIN_OWNER_EMAIL = env.owner;
      if (env.embeddings === undefined)
        delete process.env.BRAIN_QUERY_EMBEDDINGS;
      else process.env.BRAIN_QUERY_EMBEDDINGS = env.embeddings;
      if (env.tasks === undefined) delete process.env.TASKS_ENABLED;
      else process.env.TASKS_ENABLED = env.tasks;
      await cleanupOwner(ownerId);
      await pool.end();
    }
  },
);
