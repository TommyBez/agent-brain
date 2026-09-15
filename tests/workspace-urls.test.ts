import assert from "node:assert/strict";
import test from "node:test";
import {
  collectionHref,
  collectionTypeFromPathname,
  libraryHref,
  parseLibraryFilters,
} from "../lib/workspace/urls";

test("collections use addressable plural routes, including irregular people", () => {
  const collections = [
    ["person", "/people"],
    ["client", "/clients"],
    ["project", "/projects"],
    ["article", "/articles"],
    ["decision", "/decisions"],
    ["note", "/notes"],
  ] as const;

  for (const [type, path] of collections) {
    assert.equal(collectionHref(type), path);
    assert.equal(collectionTypeFromPathname(path), type);
    assert.equal(libraryHref({ type }), path);
  }
  assert.equal(collectionHref(""), "/");
  assert.equal(libraryHref(), "/");
  for (const path of ["/", "/project", "/projects-extra", "/pages/project"]) {
    assert.equal(collectionTypeFromPathname(path), "");
  }
});

test("search and pagination preserve their collection in the pathname", () => {
  const url = new URL(
    libraryHref({
      type: "project",
      query: "roadmap & milestones",
      sort: "title",
      offset: 50,
    }),
    "https://brain.example.com",
  );
  assert.equal(url.pathname, "/projects");
  assert.equal(url.searchParams.get("q"), "roadmap & milestones");
  assert.equal(url.searchParams.get("sort"), "title");
  assert.equal(url.searchParams.get("offset"), "50");
  assert.equal(url.searchParams.has("type"), false);
  assert.equal(
    libraryHref({ type: "note", offset: 0, sort: "updated" }),
    "/notes",
  );
  assert.equal(libraryHref({ query: "hello" }), "/?q=hello");
});

test("collection type comes from the route and cannot be overridden by query parameters", () => {
  const params = new URLSearchParams(
    "type=note&q=roadmap&sort=title&offset=50",
  );
  assert.deepEqual(parseLibraryFilters(params, "project"), {
    query: "roadmap",
    type: "project",
    sort: "title",
    offset: 50,
  });
  assert.equal(parseLibraryFilters(params).type, "");
  assert.equal(parseLibraryFilters(params, "person").type, "person");
});

test("collection filters still bound user-controlled search and pagination", () => {
  assert.deepEqual(
    parseLibraryFilters(
      new URLSearchParams({
        q: "   a phrase   ",
        sort: "unsafe",
        offset: "-1",
      }),
      "article",
    ),
    { query: "a phrase", type: "article", sort: "updated", offset: 0 },
  );
  assert.equal(
    parseLibraryFilters(new URLSearchParams({ q: "x".repeat(501) })).query
      .length,
    500,
  );
  assert.equal(
    parseLibraryFilters(new URLSearchParams("offset=100001")).offset,
    100_000,
  );
  for (const offset of ["1.5", "Infinity", "NaN", "9007199254740992"]) {
    assert.equal(
      parseLibraryFilters(new URLSearchParams({ offset })).offset,
      0,
    );
  }
});
