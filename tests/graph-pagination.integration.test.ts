import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getGraph } from "../lib/brain/service";
import { getPool } from "../lib/db";

test(
  "graph filters the full owner corpus before pagination and returns only visible edges",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async () => {
    const owner = `graph-pagination-${randomUUID()}`;
    const otherOwner = `graph-pagination-${randomUUID()}`;
    const db = getPool();
    try {
      const { rows: notes } = await db.query<{ id: string }>(
        `INSERT INTO brain_pages (owner_id,slug,title,type,markdown,updated_at)
         SELECT $1,'note-' || n,'Note ' || n,'note','Graph fixture','2026-01-02T00:00:00Z'
         FROM generate_series(1,205) AS n RETURNING id`,
        [owner],
      );
      const { rows: projects } = await db.query<{ id: string }>(
        `INSERT INTO brain_pages (owner_id,slug,title,type,markdown,updated_at)
         SELECT $1,'project-' || n,'Project ' || n,'project','Older graph fixture','2026-01-01T00:00:00Z'
         FROM generate_series(1,2) AS n RETURNING id`,
        [owner],
      );
      const { rows: outsider } = await db.query<{ id: string }>(
        `INSERT INTO brain_pages (owner_id,slug,title,type,markdown,updated_at)
         VALUES ($1,'private-project','Private project','project','Other owner only','2026-01-03T00:00:00Z') RETURNING id`,
        [otherOwner],
      );
      const initial = await getGraph(owner, { limit: 200 });
      const later = await getGraph(owner, { limit: 200, offset: 200 });
      assert.equal(initial.total, 207);
      assert.equal(initial.nodes.length, 200);
      assert.equal(later.nodes.length, 7);
      assert.equal(later.total, 207);
      assert.ok(initial.nodes.every((node) => node.type === "note"));
      assert.equal(
        later.nodes.filter((node) => node.type === "project").length,
        2,
      );
      const allIds = [...initial.nodes, ...later.nodes].map((node) => node.id);
      assert.equal(
        new Set(allIds).size,
        207,
        "Every page appears exactly once across adjacent graph pages",
      );
      assert.deepEqual(
        new Set(allIds),
        new Set([...notes, ...projects].map((page) => page.id)),
      );
      assert.ok(!allIds.includes(outsider[0].id));
      assert.deepEqual(
        (await getGraph(owner, { limit: 200 })).nodes.map((node) => node.id),
        initial.nodes.map((node) => node.id),
        "Equal timestamps still produce deterministic page boundaries",
      );

      const visibleSource = initial.nodes[0].id;
      const visibleTarget = initial.nodes[1].id;
      const outsideTarget = later.nodes.find(
        (node) => node.type === "note",
      )?.id;
      assert.ok(outsideTarget);
      await db.query(
        `INSERT INTO brain_links (owner_id,source_id,target_id,type)
         VALUES ($1,$2,$3,'references'),($1,$2,$4,'references'),($1,$5,$6,'references'),($1,$5,$2,'references')`,
        [
          owner,
          visibleSource,
          visibleTarget,
          outsideTarget,
          projects[0].id,
          projects[1].id,
        ],
      );
      const firstWithEdges = await getGraph(owner, { limit: 200 });
      assert.equal(firstWithEdges.links.length, 1);
      assert.equal(firstWithEdges.links[0].sourceId, visibleSource);
      assert.equal(firstWithEdges.links[0].targetId, visibleTarget);

      const filtered = await getGraph(owner, { type: "project", limit: 200 });
      assert.equal(filtered.total, 2);
      assert.deepEqual(
        new Set(filtered.nodes.map((node) => node.id)),
        new Set(projects.map((page) => page.id)),
      );
      assert.equal(filtered.links.length, 1);
      assert.equal(filtered.links[0].sourceId, projects[0].id);
      assert.equal(filtered.links[0].targetId, projects[1].id);
      const singleProject = await getGraph(owner, {
        type: "project",
        limit: 1,
      });
      assert.equal(singleProject.total, 2);
      assert.equal(singleProject.nodes.length, 1);
      assert.deepEqual(singleProject.links, []);
      const empty = await getGraph(owner, { type: "project", offset: 2 });
      assert.equal(empty.total, 2);
      assert.deepEqual(empty.nodes, []);
      assert.deepEqual(empty.links, []);
      assert.equal((await getGraph(otherOwner, { type: "project" })).total, 1);
    } finally {
      await db.query("DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])", [
        [owner, otherOwner],
      ]);
      await db.end();
    }
  },
);
