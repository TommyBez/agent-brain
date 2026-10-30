import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { brainConsolidationSpend, brainJobs } from "../lib/db/schema/brain";
import {
  brainAgents,
  brainTaskLinks,
  brainTaskSettings,
  brainTaskSuggestions,
  brainTasks,
} from "../lib/db/schema/tasks";
import {
  AGENT_TASK_ORIGINS,
  defaultReviewPolicy,
  effectiveClaimOnRequest,
  effectiveTrustedCreator,
  formatTaskRef,
  LEASED_TASK_STATUSES,
  OPEN_TASK_STATUSES,
  OWNER_REVIEWED_OUTPUTS,
  parseTaskBatchId,
  parseTaskRef,
  SPEND_PURPOSES,
  TASK_EXPECTED_OUTPUTS,
  TASK_JOB_KINDS,
  TASK_ORIGINS,
  TASK_STATUSES,
  TASK_SUGGESTION_KINDS,
  TERMINAL_TASK_STATUSES,
  taskBatchId,
} from "../lib/tasks/types";

const dialect = new PgDialect();
function checkSql(table: PgTable, name: string) {
  const constraint = getTableConfig(table).checks.find(
    (check) => check.name === name,
  );
  assert.ok(constraint, name);
  return dialect.sqlToQuery(constraint.value).sql;
}

test("task references parse T-n and uuids only", () => {
  assert.equal(formatTaskRef(42), "T-42");
  assert.deepEqual(parseTaskRef("T-42"), { kind: "number", number: 42 });
  assert.deepEqual(parseTaskRef(" t-7 "), { kind: "number", number: 7 });
  assert.deepEqual(parseTaskRef("6F9619FF-8B86-D011-B42D-00C04FC964FF"), {
    kind: "id",
    id: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
  });
  for (const invalid of [
    "T-0",
    "T-01",
    "T-",
    "42",
    "AÜ.27",
    "T-99999999999",
    "T-4294967296",
    "page/slug",
  ])
    assert.equal(parseTaskRef(invalid), null, invalid);
});

test("batch ids round-trip the source page and version", () => {
  const pageId = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
  assert.equal(taskBatchId(pageId, 3), `${pageId}@3`);
  assert.deepEqual(parseTaskBatchId(taskBatchId(pageId, 3)), {
    pageId,
    pageVersion: 3,
  });
  assert.equal(parseTaskBatchId("note@3"), null);
  assert.equal(parseTaskBatchId(`${pageId}@x`), null);
});

test("credential defaults: claim on request for OAuth, trust for tokens", () => {
  assert.equal(effectiveClaimOnRequest("agent", null, "oauth"), true);
  assert.equal(effectiveClaimOnRequest("agent", null, "token"), false);
  assert.equal(effectiveClaimOnRequest("agent", true, "token"), true);
  assert.equal(effectiveClaimOnRequest("agent", false, "oauth"), false);
  assert.equal(effectiveClaimOnRequest("owner", true, "session"), false);
  assert.equal(effectiveClaimOnRequest("system", null, "system"), false);
  assert.equal(effectiveTrustedCreator("agent", true, "token"), true);
  assert.equal(effectiveTrustedCreator("agent", true, "oauth"), false);
  assert.equal(effectiveTrustedCreator("agent", false, "token"), false);
  assert.equal(effectiveTrustedCreator("system", true, "system"), false);
});

test("decisions and external actions are always reviewed by the owner", () => {
  for (const output of TASK_EXPECTED_OUTPUTS)
    assert.equal(
      defaultReviewPolicy(output),
      (OWNER_REVIEWED_OUTPUTS as readonly string[]).includes(output)
        ? "owner"
        : "auto",
    );
});

test("status groups partition the task statuses", () => {
  assert.deepEqual(
    [...OPEN_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].sort(),
    [...TASK_STATUSES].sort(),
  );
  assert.ok(
    LEASED_TASK_STATUSES.every((status) =>
      (OPEN_TASK_STATUSES as readonly string[]).includes(status),
    ),
  );
  assert.ok(!(TASK_STATUSES as readonly string[]).includes("reconciliation"));
  assert.ok(
    AGENT_TASK_ORIGINS.every((origin) => TASK_ORIGINS.includes(origin)),
  );
  assert.ok(!(AGENT_TASK_ORIGINS as readonly string[]).includes("extracted"));
});

test("the task manager is a per-owner setting that starts off", () => {
  const enabled = getTableConfig(brainTaskSettings).columns.find(
    (column) => column.name === "enabled",
  );
  assert.ok(enabled);
  assert.equal(enabled.notNull, true);
  assert.equal(enabled.default, false);
});

test("database CHECKs are generated from the shared vocabulary", () => {
  const jobs = checkSql(brainJobs, "brain_jobs_kind_check");
  for (const kind of [
    "consolidation",
    "embeddings",
    "export",
    ...TASK_JOB_KINDS,
  ])
    assert.match(jobs, new RegExp(`'${kind}'::text`));
  const spend = checkSql(
    brainConsolidationSpend,
    "brain_consolidation_spend_purpose_check",
  );
  for (const purpose of SPEND_PURPOSES)
    assert.match(spend, new RegExp(`'${purpose}'::text`));
  const statuses = checkSql(brainTasks, "brain_tasks_status_check");
  for (const status of TASK_STATUSES)
    assert.match(statuses, new RegExp(`'${status}'::text`));
  const suggestions = checkSql(
    brainTaskSuggestions,
    "brain_task_suggestions_kind_check",
  );
  for (const kind of TASK_SUGGESTION_KINDS)
    assert.match(suggestions, new RegExp(`'${kind}'::text`));
  assert.match(
    checkSql(brainTasks, "brain_tasks_review_policy_check"),
    /'decision'::text, 'external_action'::text/,
  );
  assert.ok(checkSql(brainTaskLinks, "brain_task_links_origin_check"));
  assert.ok(checkSql(brainAgents, "brain_agents_system_key_check"));
});
