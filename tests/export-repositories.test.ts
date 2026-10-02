import assert from "node:assert/strict";
import test from "node:test";
import {
  exportRepositories,
  exportRepositoryForEmail,
} from "../lib/maintenance/export-repositories";

test("each account exports to its own repository, and a missing entry exports nowhere", () => {
  const source =
    " Owner@Example.com=TommyBez/agent-brain-memory, other@example.com=Other/memory ";
  assert.deepEqual(
    [...exportRepositories(source)],
    [
      ["owner@example.com", "TommyBez/agent-brain-memory"],
      ["other@example.com", "Other/memory"],
    ],
  );
  const previous = process.env.BRAIN_EXPORT_REPOSITORIES;
  try {
    process.env.BRAIN_EXPORT_REPOSITORIES = source;
    assert.equal(exportRepositoryForEmail("OTHER@example.com"), "Other/memory");
    assert.equal(exportRepositoryForEmail("absent@example.com"), undefined);
  } finally {
    if (previous === undefined) delete process.env.BRAIN_EXPORT_REPOSITORIES;
    else process.env.BRAIN_EXPORT_REPOSITORIES = previous;
  }
});

test("an export repository entry must be one email and one owner/repository", () => {
  assert.throws(
    () => exportRepositories("owner@example.com=not a repo"),
    /invalid entry/,
  );
  assert.throws(
    () =>
      exportRepositories(
        "owner@example.com=Owner/one,owner@example.com=Owner/two",
      ),
    /more than once/,
  );
});
