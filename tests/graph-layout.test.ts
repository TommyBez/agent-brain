import assert from "node:assert/strict";
import test from "node:test";
import {
  ALPHA_MIN,
  bounds,
  createLayout,
  hashSeed,
  type Layout,
  reheat,
  settle,
  tick,
} from "../lib/graph/layout";

const nodes = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => ({ id }));
const links = [
  { sourceId: "a", targetId: "b" },
  { sourceId: "b", targetId: "c" },
  { sourceId: "c", targetId: "a" },
  { sourceId: "d", targetId: "e" },
  { sourceId: "x", targetId: "a" },
  { sourceId: "a", targetId: "a" },
];

function positions(layout: Layout) {
  return layout.nodes.map((node) => [node.id, node.x, node.y]);
}

function distance(layout: Layout, first: string, second: string) {
  const a = layout.nodes.find((node) => node.id === first);
  const b = layout.nodes.find((node) => node.id === second);
  assert.ok(a && b);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

test("layout ignores links outside the graph and self links", () => {
  const layout = createLayout(nodes, links, 7);
  assert.equal(layout.links.length, 4);
  const degree = Object.fromEntries(
    layout.nodes.map((node) => [node.id, node.degree]),
  );
  assert.deepEqual(degree, { a: 2, b: 2, c: 2, d: 1, e: 1, f: 0, g: 0, h: 0 });
  assert.deepEqual(
    layout.nodes.filter((node) => node.isolated).map((node) => node.id),
    ["f", "g", "h"],
  );
});

test("equal graphs and seeds settle into identical layouts", () => {
  const first = settle(createLayout(nodes, links, 42));
  const second = settle(createLayout(nodes, links, 42));
  assert.deepEqual(positions(first), positions(second));
  const reseeded = settle(createLayout(nodes, links, 43));
  assert.notDeepEqual(positions(first), positions(reseeded));
});

test("settled layout is finite, settled and free of overlaps", () => {
  const layout = settle(createLayout(nodes, links, 3));
  assert.ok(layout.alpha < ALPHA_MIN);
  assert.equal(tick(layout), false);
  for (const node of layout.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), node.id);
  }
  for (const a of layout.nodes) {
    for (const b of layout.nodes) {
      if (a.index >= b.index) continue;
      assert.ok(
        Math.hypot(a.x - b.x, a.y - b.y) >= (a.r + b.r) * 0.9,
        `${a.id} overlaps ${b.id}`,
      );
    }
  }
  reheat(layout);
  assert.equal(tick(layout), true);
});

test("linked pages sit closer than unlinked ones and orphans orbit the core", () => {
  const layout = settle(createLayout(nodes, links, 11));
  const linked = distance(layout, "a", "b");
  assert.ok(linked < distance(layout, "a", "d"));
  assert.ok(linked < distance(layout, "a", "f"));
  for (const id of ["f", "g", "h"]) {
    const node = layout.nodes.find((entry) => entry.id === id);
    assert.ok(node);
    const orbit = Math.hypot(node.x, node.y);
    assert.ok(
      Math.abs(orbit - layout.ring) < layout.ring * 0.25,
      `${id} strays from the orbit: ${orbit} vs ${layout.ring}`,
    );
  }
  for (const id of ["a", "b", "c", "d", "e"]) {
    const node = layout.nodes.find((entry) => entry.id === id);
    assert.ok(node);
    assert.ok(Math.hypot(node.x, node.y) < layout.ring * 0.8, id);
  }
});

test("pinned pages stay put while the rest of the layout settles", () => {
  const layout = createLayout(nodes, links, 5);
  const pinned = layout.nodes[0];
  pinned.fx = 500;
  pinned.fy = -250;
  settle(layout);
  assert.equal(pinned.x, 500);
  assert.equal(pinned.y, -250);
});

test("graphs without links spread out instead of orbiting", () => {
  const layout = settle(createLayout(nodes, [], 9));
  assert.equal(layout.ring, 0);
  assert.ok(layout.nodes.every((node) => !node.isolated));
  const box = bounds(layout.nodes);
  assert.ok(box && box.maxX - box.minX > 50 && box.maxY - box.minY > 50);
});

test("hashSeed is stable and sensitive to content", () => {
  assert.equal(hashSeed("a|b|c"), hashSeed("a|b|c"));
  assert.notEqual(hashSeed("a|b|c"), hashSeed("a|b|d"));
  assert.equal(bounds([]), null);
});
