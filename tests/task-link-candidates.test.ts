import assert from "node:assert/strict";
import test from "node:test";
import { checkedCandidates } from "../lib/tasks/candidate-selection";
import {
  type CandidateReads,
  findTaskLinkCandidates,
} from "../lib/tasks/link-candidates";
import { suggestTaskLinksSchema } from "../lib/tasks/schemas";

const page = (id: string) => ({ id, slug: `note/${id}`, title: `Page ${id}` });
const reads: CandidateReads = {
  decisions: async () => [{ pageId: "decision" }],
  pages: async () => [page("decision")],
  search: async () => [
    page("decision"),
    page("a"),
    page("b"),
    page("c"),
    page("d"),
  ],
};
test("read-only candidate engine combines decisions and lexical matches with reasons", async () => {
  const result = await findTaskLinkCandidates(
    { title: "Review project", description: "", projectPageId: "project" },
    reads,
  );
  assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates[0].role, "decision");
  assert.ok(
    result.candidates.every(
      (candidate) => candidate.reason && candidate.score > 0,
    ),
  );
  assert.equal(
    new Set(result.candidates.map((candidate) => candidate.pageRef)).size,
    5,
  );
  assert.equal(
    (
      await findTaskLinkCandidates(
        { title: "Review", description: "", projectPageId: null },
        reads,
        2,
      )
    ).candidates.length,
    2,
  );
});
test("unchecked and cancelled choices apply nothing; confirmation applies only checked pages", async () => {
  const { candidates } = await findTaskLinkCandidates(
    { title: "Review", description: "", projectPageId: null },
    reads,
  );
  const writes: string[] = [];
  const confirm = (checked: string[]) => {
    for (const candidate of checkedCandidates(candidates, checked))
      writes.push(candidate.pageRef);
  };
  confirm([]);
  assert.deepEqual(writes, []);
  confirm(["a", "c", "unknown"]);
  assert.deepEqual(writes, ["a", "c"]);
});
test("candidate input accepts exactly a task ref or draft and caps limit at ten", () => {
  assert.ok(suggestTaskLinksSchema.safeParse({ ref: "T-1" }).success);
  assert.ok(suggestTaskLinksSchema.safeParse({ title: "Draft" }).success);
  for (const input of [
    {},
    { ref: "T-1", title: "Draft" },
    { title: "Draft", limit: 11 },
  ])
    assert.equal(suggestTaskLinksSchema.safeParse(input).success, false);
});
