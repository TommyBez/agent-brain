import assert from "node:assert/strict";
import test from "node:test";
import { briefRefs, orderBriefLinks } from "../lib/tasks/brief";

test("the brief cites only the project and confirmed active links by role", () => {
  const brief = (
    pageId: string,
    role: string,
    status: string,
    confidence: number | null,
  ) => ({
    pageId,
    slug: pageId,
    title: pageId,
    role,
    origin: "rule",
    status,
    confidence,
  });
  const links = [
    brief("s-low", "context", "suggested", 0.81),
    brief("a-context", "context", "active", null),
    brief("s-high", "decision", "suggested", 0.95),
    brief("a-source", "source", "active", null),
    brief("p-suggested", "produced", "suggested", null),
    brief("a-source", "context", "active", null),
  ];
  assert.deepEqual(
    orderBriefLinks(links).map((item) => item.pageId),
    ["a-source", "a-context"],
  );
  assert.deepEqual(
    briefRefs({
      ownerId: "o",
      ref: "T-1",
      title: "T",
      acceptanceCriteria: [],
      projectPageId: "project",
      linkedPageIds: [],
      links: [
        ...links,
        ...Array.from({ length: 12 }, (_, index) =>
          brief(`x${index}`, "context", "suggested", 0.5),
        ),
      ],
      history: [],
    }).slice(0, 5),
    ["project", "a-source", "a-context"],
  );
});
