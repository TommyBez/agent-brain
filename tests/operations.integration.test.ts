import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { write } from "../lib/brain/service";
import { getPool } from "../lib/db";
import { exportBrain } from "../lib/operations";

test(
  "snapshot exports retain typed links and isolate owners",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `operations-test-${randomUUID()}`;
    const outsider = `operations-test-${randomUUID()}`;
    try {
      await t.test(
        "snapshot exports retain typed links and exclude other owners",
        async () => {
          const person = await write(owner, {
            title: "Export Tester",
            type: "person",
            markdown: "Temporary integration fixture.",
            expectedVersion: 0,
          });
          const project = await write(owner, {
            title: "Export Check",
            type: "project",
            markdown: "Temporary integration fixture.",
            expectedVersion: 0,
            links: [{ targetRef: person.id, type: "owns" }],
          });
          await write(outsider, {
            title: "Private outsider",
            type: "note",
            markdown: "Must never enter the export.",
            expectedVersion: 0,
          });
          const snapshot = await exportBrain(owner);
          assert.equal(snapshot.pages.length, 2);
          assert.equal(snapshot.links.length, 1);
          assert.equal(snapshot.links[0].sourceId, project.id);
          assert.equal(snapshot.links[0].targetSlug, person.slug);
          assert.ok(
            snapshot.pages.every(
              (page) => page.id === person.id || page.id === project.id,
            ),
          );
        },
      );
    } finally {
      await getPool().query(
        "DELETE FROM brain_jobs WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().end();
    }
  },
);
