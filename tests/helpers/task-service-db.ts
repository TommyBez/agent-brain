import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { Actor } from "../../lib/tasks/actors";

export const PAGE_IDS = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
  "20000000-0000-4000-8000-000000000004",
];
const NOW = "2026-11-02T10:00:00.000Z";
type Row = Record<string, unknown>;
export interface LinkRow extends Row {
  page_id: string;
  role: string;
  origin: string;
  status: string;
}

export function serviceActor(kind: "owner" | "agent" | "system"): Actor {
  return {
    ownerId: "service-test-owner",
    agentId: "30000000-0000-4000-8000-000000000001",
    agent: {
      id: "30000000-0000-4000-8000-000000000001",
      kind,
      systemKey: kind === "system" ? "task_keeper" : null,
      label: "Service test actor",
      labelVerified: true,
      capabilities: [],
      createPolicy: "triage",
      trustedCreator: false,
      claimOnRequest: false,
      personPageId: null,
      disabledAt: null,
      lastSeenAt: null,
      createdAt: NOW,
    },
    credential:
      kind === "owner" ? "session" : kind === "system" ? "system" : "token",
    trustedCreator: false,
    claimOnRequest: false,
  };
}

/** SQL adapter for the real service, records every task/link write (not just final rows).
 * Unknown queries are retained before throwing: caught derived-link failures must
 * still fail the test, rather than silently making the fake look read-only.
 */
export class TaskServiceDb {
  readonly transactions: string[] = [];
  private snapshot: {
    tasks: [string, Row][];
    links: [string, LinkRow][];
    events: Row[];
  } | null = null;
  readonly tasks = new Map<string, Row>();
  readonly links = new Map<string, LinkRow>();
  readonly taskWrites: { operation: "insert" | "update"; row: Row }[] = [];
  readonly linkWrites: LinkRow[] = [];
  readonly events: Row[] = [];
  readonly queries: string[] = [];
  readonly unexpected: string[] = [];
  readonly pages = PAGE_IDS.map((id, index) => ({
    id,
    slug: `note/service-page-${index + 1}`,
    title: `Service page ${index + 1}`,
    owner_id: "",
    type: "note",
    version: 1,
  }));
  constructor(readonly actor: Actor) {
    for (const page of this.pages) page.owner_id = actor.ownerId;
  }

  async connect() {
    return this;
  }
  release() {}

  async query(sql: string, params: unknown[] = []) {
    const statement = sql.replace(/\s+/g, " ").trim();
    this.queries.push(statement);
    const result = (rows: Row[] = []) => ({ rows, rowCount: rows.length });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) {
      this.transactions.push(statement);
      if (statement === "BEGIN") {
        assert.equal(this.snapshot, null, "no nested transactions");
        this.snapshot = structuredClone({
          tasks: [...this.tasks],
          links: [...this.links],
          events: this.events,
        });
      } else {
        assert.ok(this.snapshot, "transaction must be open");
        if (statement === "ROLLBACK") {
          this.tasks.clear();
          for (const [id, row] of this.snapshot.tasks) this.tasks.set(id, row);
          this.links.clear();
          for (const [id, row] of this.snapshot.links) this.links.set(id, row);
          this.events.splice(0, this.events.length, ...this.snapshot.events);
        }
        this.snapshot = null;
      }
      return result();
    }
    if (statement.startsWith("SELECT pg_advisory_xact_lock(")) return result();
    if (statement.startsWith("SELECT count(*) FILTER (WHERE created_at"))
      return result([
        { today: this.tasks.size, triage: this.tasks.size, retry: 0 },
      ]);
    if (
      statement.startsWith(
        "SELECT id, slug, title, type, version FROM brain_pages",
      )
    ) {
      const refs = params[1] as string[];
      return result(
        this.pages.filter(
          (page) =>
            page.owner_id === params[0] &&
            (refs.includes(page.id) || refs.includes(page.slug)),
        ),
      );
    }
    if (
      statement.startsWith(
        "SELECT id, idempotency_fingerprint FROM brain_tasks",
      )
    ) {
      return result(
        [...this.tasks.values()].filter(
          (row) =>
            row.owner_id === params[0] &&
            row.created_by_agent_id === params[1] &&
            row.idempotency_key === params[2],
        ),
      );
    }
    if (statement.startsWith("INSERT INTO brain_tasks (")) {
      const columns = [
        "owner_id",
        "title",
        "description",
        "acceptance_criteria",
        "expected_output",
        "status",
        "priority",
        "due_kind",
        "due_on",
        "due_at",
        "due_text",
        "requires_human",
        "review_policy",
        "delegate_agent_id",
        "required_capability",
        "project_page_id",
        "parent_task_id",
        "origin",
        "owner_quote",
        "created_by_agent_id",
        "approved_by_agent_id",
        "idempotency_key",
        "idempotency_fingerprint",
      ];
      const id = `10000000-0000-4000-8000-${String(this.tasks.size + 1).padStart(12, "0")}`;
      const row: Row = {
        ...Object.fromEntries(
          columns.map((column, index) => [column, params[index]]),
        ),
        id,
        number: this.tasks.size + 1,
        version: 1,
        approved_at: params[20] ? NOW : null,
        blocked_reason: null,
        status_note: null,
        claimed_by_agent_id: null,
        lease_id: null,
        lease_expires_at: null,
        lease_live: false,
        claimed_at: null,
        claim_count: 0,
        input_requested_at: null,
        completion: null,
        completed_at: null,
        batch_id: null,
        recurrence_id: null,
        archived_at: null,
        created_at: NOW,
        updated_at: NOW,
        creator_label: this.actor.agent.label,
        creator_kind: this.actor.agent.kind,
        creator_label_verified: true,
        open_blockers: 0,
      };
      this.tasks.set(id, row);
      this.taskWrites.push({ operation: "insert", row: structuredClone(row) });
      return result([{ id, number: row.number }]);
    }
    if (statement.startsWith("UPDATE brain_tasks SET ")) {
      const row = this.tasks.get(String(params[1]));
      assert.ok(row, "update must target a persisted task");
      const assignments = statement.split(" WHERE ")[0];
      for (const match of assignments.matchAll(/(\w+) = \$(\d+)/g))
        row[match[1]] = params[Number(match[2]) - 1];
      if (assignments.includes("version = version + 1"))
        row.version = Number(row.version) + 1;
      this.taskWrites.push({ operation: "update", row: structuredClone(row) });
      return result();
    }
    if (statement.startsWith("INSERT INTO brain_task_links AS l ")) {
      const writes = JSON.parse(String(params[4])) as LinkRow[];
      for (const write of writes) {
        const row = {
          ...write,
          task_id: String(params[1]),
          created_by_agent_id: params[2],
        };
        this.linkWrites.push(structuredClone(row));
        this.links.set(`${params[1]}:${write.page_id}:${write.role}`, row);
      }
      return result(writes);
    }
    if (statement.startsWith("INSERT INTO brain_task_events (")) {
      this.events.push({ action: params[3], task_id: params[1] });
      return result();
    }
    if (
      statement.startsWith(
        "SELECT t.number, t.title, t.status, round(similarity(",
      )
    )
      return result();
    if (
      statement.startsWith("SELECT t.id, t.number, t.title,") &&
      statement.includes("FROM brain_tasks t")
    ) {
      const row = [...this.tasks.values()].find((task) =>
        typeof params[1] === "number"
          ? task.number === params[1]
          : task.id === params[1],
      );
      return result(row ? [structuredClone(row)] : []);
    }
    if (statement.startsWith("SELECT l.page_id, l.role, l.origin, l.status,")) {
      return result(
        [...this.links.values()]
          .filter((link) => link.task_id === params[1])
          .map((link) => {
            const page = this.pages.find((page) => page.id === link.page_id);
            assert.ok(page);
            return { ...link, ...page, passage: null };
          }),
      );
    }
    this.unexpected.push(statement);
    throw new Error(`Unexpected service SQL: ${statement}`);
  }
}

export function installServiceDb(t: TestContext, actor: Actor) {
  const db = new TaskServiceDb(actor);
  const globalPool = globalThis as typeof globalThis & { brainPool?: Pool };
  const previousPool = globalPool.brainPool;
  const previousUrl = process.env.DATABASE_URL;
  // Only satisfies getPool's configuration guard. The cache is replaced before
  // service calls, and actual pg/provider access is forbidden below. No .env is read.
  process.env.DATABASE_URL = "postgresql://unused.invalid/never-connect";
  globalPool.brainPool = db as unknown as Pool;
  const forbidden = (operation: string) => {
    db.unexpected.push(operation);
    throw new Error(`${operation} is forbidden in an in-memory service test`);
  };
  t.mock.method(Pool.prototype, "connect", () =>
    forbidden("real Pool.connect"),
  );
  t.mock.method(Pool.prototype, "query", () => forbidden("real Pool.query"));
  t.mock.method(globalThis, "fetch", () => forbidden("provider fetch"));
  t.after(() => {
    globalPool.brainPool = previousPool;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    assert.deepEqual(
      db.unexpected,
      [],
      "unexpected SQL/access must fail even when swallowed by derived-link code",
    );
  });
  return db;
}
