import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrainExportSnapshot,
  exportBrainToGitHub,
  GitHubExportError,
} from "../lib/maintenance/github-export";

import {
  GitHub,
  marker,
  repository,
  required,
  type StoredCommit,
} from "./helpers/github-export";

const snapshot = (): BrainExportSnapshot => ({
  schemaVersion: 1,
  exportedAt: "2026-09-14T02:00:00.000Z",
  pages: [
    {
      id: "page-one",
      slug: "project/brain",
      title: "Brain",
      type: "project",
      markdown: "# Brain\n\nComplete content: à 🧠\n",
      aliases: ["Second brain"],
      version: 3,
    },
  ],
  links: [
    {
      id: "link-one",
      sourceId: "page-one",
      targetId: "page-one",
      type: "relates_to",
    },
  ],
});
const options = (github: GitHub, jobId = "job-one") => ({
  snapshot: snapshot(),
  runDate: "2026-09-14",
  jobId,
  repository,
  branch: "main",
  token: "test-export-key",
  fetch: github.fetch,
});

test("GitHub export preserves source files, replaces owned pages, and publishes one verified commit", async () => {
  const github = new GitHub();
  const originalHead = github.head;
  const result = await exportBrainToGitHub(options(github));
  assert.deepEqual(result, {
    pages: 1,
    links: 1,
    commit: github.head,
    pushed: true,
    repository,
  });
  assert.equal(
    required(github.commits.get(github.head)).parents[0].sha,
    originalHead,
  );
  assert.equal(github.file("README.md"), "Keep repository source\n");
  assert.equal(github.file(".github/workflows/nightly.yml"), "Keep workflow\n");
  assert.equal(github.file("export/notes.txt"), "Unrelated export note\n");
  assert.equal(github.file("export/pages/project/obsolete.md"), undefined);
  assert.match(
    required(github.file("export/pages/project/brain.md")),
    /Complete content: à 🧠/,
  );
  assert.match(
    required(github.file("export/pages/project/brain.md")),
    /links: \[/,
  );
  assert.deepEqual(
    JSON.parse(required(github.file("export/graph.json"))),
    snapshot().links,
  );
  assert.equal(
    JSON.parse(required(github.file("export/manifest.json"))).exportedAt,
    snapshot().exportedAt,
  );
  assert.equal(
    JSON.parse(required(github.file("export/receipts/job-one.json"))).jobId,
    "job-one",
  );
  assert.equal(
    github.calls.filter((call) => call.path === "/git/commits").length,
    1,
  );
  assert.equal(
    required(github.calls.at(-1)).path,
    "/git/ref/heads/main",
    "Success requires branch readback",
  );
});

test("80 complete pages use four sequential inline-content tree batches without individual page uploads", async () => {
  const github = new GitHub();
  const input = options(github);
  input.snapshot.pages = Array.from({ length: 80 }, (_, index) => ({
    id: `page-${index}`,
    slug: `project/page-${String(index).padStart(2, "0")}`,
    markdown: `# Page ${index}\n${"Full content à 🧠\n".repeat(600)}End ${index}`,
    version: 1,
  }));
  input.snapshot.links = [];
  const result = await exportBrainToGitHub(input);
  assert.equal(result.pages, 80);
  const batches = github.calls.filter(
    (call) =>
      call.path === "/git/trees" &&
      Array.isArray(call.body?.tree) &&
      call.body.tree.some((entry) => "content" in entry),
  );
  assert.deepEqual(
    batches.map((call) => (call.body?.tree as unknown[]).length),
    [24, 24, 24, 8],
  );
  assert.equal(batches[0].body?.base_tree, undefined);
  assert.ok(batches.slice(1).every((call) => call.body?.base_tree));
  for (const page of input.snapshot.pages) {
    assert.ok(
      required(github.file(`export/pages/${page.slug}.md`)).endsWith(
        `${page.markdown}\n`,
      ),
      `The complete contents of ${page.slug} survive batching`,
    );
  }
  assert.equal(github.file("export/pages/project/obsolete.md"), undefined);
  assert.equal(github.file("README.md"), "Keep repository source\n");
  assert.equal(github.file("export/notes.txt"), "Unrelated export note\n");
  const blobCalls = github.calls.filter((call) => call.path === "/git/blobs");
  assert.ok(blobCalls.length <= 4, "Only export metadata uses blob requests");
  assert.equal(
    blobCalls.some((call) =>
      input.snapshot.pages.some((page) =>
        String(call.body?.content).includes(page.markdown),
      ),
    ),
    false,
    "No individual page uploads",
  );
  const writes = github.calls.filter((call) => call.method !== "GET").length;
  assert.deepEqual(await exportBrainToGitHub(input), result);
  assert.equal(
    github.calls.filter((call) => call.method !== "GET").length,
    writes,
    "Replaying the batched export performs no new writes",
  );
});

test("GitHub permission failures and rate limits retain safe retry classification and timing", async () => {
  const reset = Math.ceil(Date.now() / 1000) + 120;
  const retryDate = new Date((reset + 30) * 1000).toUTCString();
  const cases: {
    status: number;
    headers: Record<string, string>;
    retryable: boolean;
    delay: number | null | "reset" | "date";
  }[] = [
    { status: 403, headers: {}, retryable: false, delay: null },
    {
      status: 403,
      headers: { "retry-after": "90" },
      retryable: true,
      delay: 90_000,
    },
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      },
      retryable: true,
      delay: "reset",
    },
    {
      status: 403,
      headers: { "retry-after": retryDate },
      retryable: true,
      delay: "date",
    },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "invalid" },
      retryable: true,
      delay: 60_000,
    },
    { status: 429, headers: {}, retryable: true, delay: 60_000 },
    {
      status: 503,
      headers: { "retry-after": "15" },
      retryable: true,
      delay: 15_000,
    },
    { status: 500, headers: {}, retryable: true, delay: null },
  ];
  for (const expected of cases) {
    const before = Date.now();
    await assert.rejects(
      exportBrainToGitHub({
        ...options(new GitHub()),
        fetch: async () =>
          Response.json(
            { message: "private provider details test-export-key" },
            { status: expected.status, headers: expected.headers },
          ),
      }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubExportError);
        assert.equal(error.status, expected.status);
        assert.equal(error.retryable, expected.retryable);
        if (expected.delay === "reset" || expected.delay === "date") {
          const deadline =
            (reset + (expected.delay === "date" ? 30 : 0)) * 1000;
          assert.ok(required(error.retryAfterMs) >= deadline - Date.now());
          assert.ok(required(error.retryAfterMs) <= deadline - before);
        } else assert.equal(error.retryAfterMs, expected.delay);
        assert.equal(error.message.includes("private provider details"), false);
        assert.equal(error.message.includes("test-export-key"), false);
        return true;
      },
    );
  }
});

test("a rate-limited ref update pauses further GitHub calls for the Workflow retry", async () => {
  const github = new GitHub();
  const originalHead = github.head;
  let rateLimited = false;
  await assert.rejects(
    exportBrainToGitHub({
      ...options(github),
      fetch: async (input, init) => {
        assert.equal(
          rateLimited,
          false,
          "Do not issue requests after a rate limit",
        );
        if (init?.method === "PATCH") {
          rateLimited = true;
          return Response.json(
            { message: "private provider details" },
            { status: 403, headers: { "retry-after": "60" } },
          );
        }
        return github.fetch(input, init);
      },
    }),
    (error: unknown) =>
      error instanceof GitHubExportError &&
      error.retryable === true &&
      error.retryAfterMs === 60_000,
  );
  assert.equal(github.head, originalHead);
  const result = await exportBrainToGitHub(options(github));
  assert.equal(result.commit, github.head);
});

test("a replay after later exports reuses the original job commit and original counts", async () => {
  const github = new GitHub();
  const first = await exportBrainToGitHub(options(github));
  github.advance({ "README.md": "A later unrelated edit" });
  const next = options(github, "job-two");
  next.snapshot = {
    ...snapshot(),
    pages: [],
    links: [],
    exportedAt: "2026-09-15T02:00:00.000Z",
  };
  next.runDate = "2026-09-15";
  await exportBrainToGitHub(next);
  const head = github.head;
  const writes = github.calls.filter((call) => call.method !== "GET").length;
  const replay = await exportBrainToGitHub({
    ...options(github),
    snapshot: next.snapshot,
  });
  assert.deepEqual(replay, first);
  assert.equal(github.head, head);
  assert.equal(
    github.calls.filter((call) => call.method !== "GET").length,
    writes,
  );
  assert.equal(github.file("export/pages/project/brain.md"), undefined);
  assert.ok(github.file("export/receipts/job-one.json"));
  assert.ok(github.file("export/receipts/job-two.json"));
});

test("a new daily job attempt publishes an updated snapshot and retries replay that attempt's receipt", async () => {
  const github = new GitHub();
  const jobId = "daily-export-job";
  const firstInput = options(github, jobId);
  const first = await exportBrainToGitHub(firstInput);
  const firstReceipt = required(github.file(`export/receipts/${jobId}.json`));
  assert.equal(JSON.parse(firstReceipt).jobId, jobId);

  const secondInput = options(github, `${jobId}-attempt-2`);
  secondInput.snapshot.exportedAt = "2026-09-14T03:00:00.000Z";
  secondInput.snapshot.pages[0].markdown = "# Brain\n\nUpdated in attempt 2\n";
  secondInput.snapshot.pages[0].version = 4;
  secondInput.snapshot.pages.push({
    id: "page-two",
    slug: "project/new-page",
    markdown: "# A page added before attempt 2\n",
    version: 1,
  });
  secondInput.snapshot.links = [];
  const second = await exportBrainToGitHub(secondInput);
  assert.notEqual(second.commit, first.commit);
  assert.equal(second.commit, github.head);
  assert.equal(
    required(github.commits.get(second.commit)).parents[0].sha,
    first.commit,
  );
  assert.equal(second.pages, 2);
  assert.equal(second.links, 0);
  const secondReceiptPath = `export/receipts/${jobId}-attempt-2.json`;
  const secondReceipt = required(github.file(secondReceiptPath));
  assert.deepEqual(JSON.parse(secondReceipt), {
    schemaVersion: 1,
    jobId: `${jobId}-attempt-2`,
    runDate: firstInput.runDate,
    exportedAt: secondInput.snapshot.exportedAt,
    pages: 2,
    links: 0,
  });
  assert.equal(github.file(`export/receipts/${jobId}.json`), firstReceipt);
  const publishedPage = required(github.file("export/pages/project/brain.md"));
  assert.match(publishedPage, /Updated in attempt 2/);
  assert.ok(github.file("export/pages/project/new-page.md"));
  assert.deepEqual(JSON.parse(required(github.file("export/graph.json"))), []);
  const manifest = required(github.file("export/manifest.json"));
  assert.equal(JSON.parse(manifest).jobId, secondInput.jobId);

  const writes = github.calls.filter((call) => call.method !== "GET").length;
  const replay = await exportBrainToGitHub({
    ...secondInput,
    snapshot: {
      ...snapshot(),
      exportedAt: "2026-09-14T04:00:00.000Z",
      pages: [],
      links: [],
    },
  });
  assert.deepEqual(replay, second);
  assert.equal(github.head, second.commit);
  assert.equal(github.file(secondReceiptPath), secondReceipt);
  assert.equal(github.file("export/manifest.json"), manifest);
  assert.equal(github.file("export/pages/project/brain.md"), publishedPage);
  assert.ok(github.file("export/pages/project/new-page.md"));
  assert.equal(
    github.calls.filter((call) => call.method !== "GET").length,
    writes,
  );
});

test("a concurrent ref change is rebased without overwriting unrelated repository work", async () => {
  const github = new GitHub();
  github.conflictOnce = true;
  const result = await exportBrainToGitHub(options(github));
  assert.equal(result.commit, github.head);
  assert.equal(github.file("README.md"), "Concurrent edit retained\n");
  assert.equal(github.file("new-source.ts"), "export const value = 1;\n");
  assert.ok(github.file("export/pages/project/brain.md"));
  assert.equal(
    github.calls.filter((call) => call.method === "PATCH").length,
    2,
  );
  const ancestry: string[] = [];
  let id: string | undefined = github.head;
  while (id) {
    const commit: StoredCommit = required(github.commits.get(id));
    ancestry.push(commit.message);
    id = commit.parents[0]?.sha;
  }
  assert.equal(
    ancestry.filter((message) => message.includes("Agent-Brain-Job: job-one"))
      .length,
    1,
  );
});

test("an ambiguous ref update is confirmed by readback without publishing twice", async () => {
  const github = new GitHub();
  github.ambiguousOnce = true;
  const result = await exportBrainToGitHub(options(github));
  assert.equal(result.commit, github.head);
  assert.equal(
    github.calls.filter((call) => call.method === "PATCH").length,
    1,
  );
});

test("publication is confirmed even if another source commit arrives before readback", async () => {
  const github = new GitHub();
  github.advanceAfterPush = true;
  github.ambiguousOnce = true;
  const result = await exportBrainToGitHub(options(github));
  assert.notEqual(result.commit, github.head);
  assert.equal(
    required(github.commits.get(github.head)).parents[0].sha,
    result.commit,
  );
  assert.equal(github.file("after-export.md"), "A later source commit\n");
  assert.equal(
    github.calls.filter((call) => call.method === "PATCH").length,
    1,
  );
});

test("repeated concurrent ref changes stop after three attempts without forcing publication", async () => {
  const github = new GitHub();
  github.conflictAlways = true;
  await assert.rejects(
    exportBrainToGitHub(options(github)),
    /after three attempts/,
  );
  assert.equal(
    github.calls.filter((call) => call.method === "PATCH").length,
    3,
  );
  assert.equal(github.file("export/receipts/job-one.json"), undefined);
  assert.equal(github.file("README.md"), "Concurrent edit retained\n");
});

test("Workflow retry recovers a committed export when the previous readback failed", async () => {
  const github = new GitHub();
  github.readbackFailureOnce = true;
  await assert.rejects(
    exportBrainToGitHub(options(github)),
    (error: unknown) =>
      error instanceof GitHubExportError &&
      error.status === 503 &&
      !error.message.includes("private provider detail"),
  );
  const head = github.head;
  const result = await exportBrainToGitHub(options(github));
  assert.equal(result.commit, head);
  assert.equal(
    github.calls.filter((call) => call.method === "PATCH").length,
    1,
  );
});

test("private destination and ownership are checked before any content upload", async () => {
  for (const configure of [
    (github: GitHub) => {
      github.private = false;
    },
    (github: GitHub) => {
      github.fullName = "other/private-repository";
    },
    (github: GitHub) => {
      github.advance({ "export/.agent-brain-export": "Not ours" });
    },
  ]) {
    const github = new GitHub();
    configure(github);
    await assert.rejects(
      exportBrainToGitHub(options(github)),
      GitHubExportError,
    );
    assert.equal(
      github.calls.some((call) => call.method !== "GET"),
      false,
    );
  }
  const owned = new GitHub({ "README.md": "Untouched" });
  await exportBrainToGitHub(options(owned));
  assert.equal(owned.file("README.md"), "Untouched");
  assert.equal(owned.file("export/.agent-brain-export"), marker);
});

test("invalid paths and rejected ref updates fail without exposing credentials or provider bodies", async () => {
  const github = new GitHub();
  const unsafe = options(github);
  unsafe.snapshot.pages[0].slug = "../../README";
  await assert.rejects(exportBrainToGitHub(unsafe), /Invalid page/);
  assert.equal(
    github.calls.some((call) => call.method !== "GET"),
    false,
  );
  const head = github.head;
  github.rejectPush = true;
  await assert.rejects(
    exportBrainToGitHub(options(github)),
    (error: unknown) =>
      error instanceof GitHubExportError &&
      error.status === 403 &&
      !error.message.includes("test-export-key") &&
      !error.message.includes("private branch protection"),
  );
  assert.equal(github.head, head);
  assert.equal(
    github.calls.filter((call) => call.method === "PATCH").length,
    1,
  );
});

test("incomplete trees and externally altered receipts fail closed", async () => {
  const incomplete = new GitHub();
  incomplete.truncateTrees = true;
  await assert.rejects(
    exportBrainToGitHub(options(incomplete)),
    /incomplete export tree/,
  );
  assert.equal(
    incomplete.calls.some((call) => call.method !== "GET"),
    false,
  );
  const altered = new GitHub();
  await exportBrainToGitHub(options(altered));
  altered.advance({ "export/receipts/job-one.json": "{}" });
  const writes = altered.calls.filter((call) => call.method !== "GET").length;
  await assert.rejects(
    exportBrainToGitHub(options(altered)),
    /changed outside its original commit/,
  );
  assert.equal(
    altered.calls.filter((call) => call.method !== "GET").length,
    writes,
  );
});

test("fixed snapshot metadata generates stable commits and environment defaults are read per invocation", async () => {
  const first = new GitHub();
  const second = new GitHub();
  const original = options(first);
  const reordered = options(second);
  reordered.snapshot.pages[0] = Object.fromEntries(
    Object.entries(reordered.snapshot.pages[0]).reverse(),
  ) as BrainExportSnapshot["pages"][number];
  const a = await exportBrainToGitHub(original);
  const b = await exportBrainToGitHub(reordered);
  assert.equal(a.commit, b.commit);
  const previous = {
    BRAIN_EXPORT_GITHUB_TOKEN: process.env.BRAIN_EXPORT_GITHUB_TOKEN,
    BRAIN_EXPORT_REPOSITORY: process.env.BRAIN_EXPORT_REPOSITORY,
    BRAIN_EXPORT_BRANCH: process.env.BRAIN_EXPORT_BRANCH,
  };
  try {
    process.env.BRAIN_EXPORT_GITHUB_TOKEN = "test-export-key";
    delete process.env.BRAIN_EXPORT_REPOSITORY;
    delete process.env.BRAIN_EXPORT_BRANCH;
    const github = new GitHub();
    const {
      token: _token,
      repository: _repository,
      branch: _branch,
      ...defaults
    } = options(github);
    await exportBrainToGitHub(defaults);
    assert.ok(github.file("export/manifest.json"));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
