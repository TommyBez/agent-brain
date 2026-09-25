import assert from "node:assert/strict";
import { createHash } from "node:crypto";

type Entry = { path: string; mode: string; type: string; sha: string };
export type StoredCommit = {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: { sha: string }[];
};
type TreeChange = Omit<Entry, "sha"> &
  ({ sha: string | null } | { content: string });
export const repository = "TommyBez/agent-brain-memory";
const sha = (value: string) => createHash("sha1").update(value).digest("hex");
export const marker = "Agent Brain nightly export directory\n";
export function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

// An in-memory Git graph: parent commits, immutable trees, nested paths, and
// fast-forward-only refs. Tests assert the published snapshot, not call order.
export class GitHub {
  blobs = new Map<string, string>();
  trees = new Map<string, Entry[]>();
  commits = new Map<string, StoredCommit>();
  calls: {
    method: string;
    path: string;
    body: Record<string, unknown> | undefined;
  }[] = [];
  head: string;
  private = true;
  fullName = repository;
  conflictOnce = false;
  conflictAlways = false;
  ambiguousOnce = false;
  advanceAfterPush = false;
  truncateTrees = false;
  readbackFailureOnce = false;
  private failNextReadback = false;
  rejectPush = false;

  constructor(
    files: Record<string, string> = {
      "README.md": "Keep repository source\n",
      ".github/workflows/nightly.yml": "Keep workflow\n",
      "export/.agent-brain-export": marker,
      "export/pages/project/obsolete.md": "An older page\n",
      "export/notes.txt": "Unrelated export note\n",
    },
  ) {
    const root = this.changeTree(
      undefined,
      Object.entries(files).map(([path, content]) => ({
        path,
        type: "blob",
        mode: "100644",
        sha: this.blob(content),
      })),
    );
    this.head = this.commit("Initial repository", root, []);
  }
  blob(content: string) {
    const id = sha(`blob ${Buffer.byteLength(content)}\0${content}`);
    this.blobs.set(id, content);
    return id;
  }
  changeTree(base: string | undefined, changes: TreeChange[]): string {
    const entries = new Map(
      (base ? required(this.trees.get(base)) : []).map((entry) => [
        entry.path,
        { ...entry },
      ]),
    );
    for (const input of changes) {
      if ("content" in input) {
        assert.equal(
          "sha" in input,
          false,
          "GitHub rejects both sha and content",
        );
        assert.equal(input.type, "blob");
      }
      const change =
        "content" in input
          ? {
              path: input.path,
              type: input.type,
              mode: input.mode,
              sha: this.blob(input.content),
            }
          : input;
      const [name, ...rest] = change.path.split("/");
      if (rest.length) {
        const previous = entries.get(name);
        assert.ok(!previous || previous.type === "tree");
        const child = this.changeTree(previous?.sha, [
          { ...change, path: rest.join("/") },
        ]);
        entries.set(name, {
          path: name,
          type: "tree",
          mode: "040000",
          sha: child,
        });
      } else if (change.sha === null) {
        assert.ok(
          entries.has(name),
          "GitHub rejects deleting a nonexistent path",
        );
        entries.delete(name);
      } else entries.set(name, { ...change, sha: change.sha });
    }
    const tree = [...entries.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const id = sha(`tree ${JSON.stringify(tree)}`);
    this.trees.set(id, tree);
    return id;
  }
  commit(
    message: string,
    tree: string,
    parents: string[],
    extra: unknown = null,
  ) {
    const id = sha(JSON.stringify({ message, tree, parents, extra }));
    this.commits.set(id, {
      sha: id,
      message,
      tree: { sha: tree },
      parents: parents.map((sha) => ({ sha })),
    });
    return id;
  }
  entry(commit: string, path: string): Entry | undefined {
    let root = required(this.commits.get(commit)).tree.sha;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const entry = required(this.trees.get(root)).find(
        (entry) => entry.path === parts[index],
      );
      if (!entry) return undefined;
      if (index === parts.length - 1) return entry;
      if (entry.type !== "tree") return undefined;
      root = entry.sha;
    }
  }
  file(path: string, commit = this.head) {
    const entry = this.entry(commit, path);
    return entry?.type === "blob" ? this.blobs.get(entry.sha) : undefined;
  }
  advance(
    files: Record<string, string>,
    message = "Concurrent repository update",
  ) {
    const root = this.changeTree(
      required(this.commits.get(this.head)).tree.sha,
      Object.entries(files).map(([path, content]) => ({
        path,
        type: "blob",
        mode: "100644",
        sha: this.blob(content),
      })),
    );
    this.head = this.commit(message, root, [this.head]);
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-export-key",
    );
    assert.equal(url.pathname.startsWith(`/repos/${repository}`), true);
    const path = url.pathname.slice(`/repos/${repository}`.length);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    const response = (value: unknown, status = 200) =>
      Response.json(value, { status });
    if (!path)
      return response({ private: this.private, full_name: this.fullName });
    if (path.startsWith("/git/ref/heads/")) {
      if (this.failNextReadback) {
        this.failNextReadback = false;
        return response({ message: "private provider detail" }, 503);
      }
      return response({
        ref: "refs/heads/main",
        object: { type: "commit", sha: this.head },
      });
    }
    if (path === "/commits") {
      assert.equal(url.searchParams.get("per_page"), "1");
      let id: string | undefined = required(url.searchParams.get("sha"));
      const file = required(url.searchParams.get("path"));
      while (id) {
        const commit: StoredCommit = required(this.commits.get(id));
        const previous: string | undefined = commit.parents[0]?.sha;
        if (
          this.entry(id, file)?.sha !==
          (previous ? this.entry(previous, file)?.sha : undefined)
        )
          return response([{ sha: id }]);
        id = previous;
      }
      return response([]);
    }
    if (path.startsWith("/git/commits/"))
      return response(
        required(this.commits.get(required(path.split("/").at(-1)))),
      );
    if (path.startsWith("/git/trees/")) {
      const id = required(path.split("/").at(-1));
      return response({
        sha: id,
        tree: this.trees.get(id),
        truncated: this.truncateTrees,
      });
    }
    if (path.startsWith("/git/blobs/"))
      return response({
        encoding: "base64",
        content: Buffer.from(
          required(this.blobs.get(required(path.split("/").at(-1)))),
        ).toString("base64"),
      });
    if (path === "/git/blobs" && method === "POST") {
      assert.equal(body.encoding, "utf-8");
      return response({ sha: this.blob(body.content) }, 201);
    }
    if (path === "/git/trees" && method === "POST")
      return response({ sha: this.changeTree(body.base_tree, body.tree) }, 201);
    if (path === "/git/commits" && method === "POST")
      return response(
        {
          sha: this.commit(body.message, body.tree, body.parents, {
            author: body.author,
            committer: body.committer,
          }),
        },
        201,
      );
    if (path === "/git/refs/heads/main" && method === "PATCH") {
      assert.equal(body.force, false);
      if (this.rejectPush)
        return response({ message: "private branch protection details" }, 403);
      if (this.conflictOnce || this.conflictAlways) {
        this.conflictOnce = false;
        this.advance({
          "README.md": "Concurrent edit retained\n",
          "new-source.ts": "export const value = 1;\n",
        });
      }
      const candidate = required(this.commits.get(body.sha));
      if (body.sha !== this.head && candidate.parents[0]?.sha !== this.head)
        return response({ message: "Not a fast forward" }, 422);
      this.head = body.sha;
      if (this.advanceAfterPush) {
        this.advanceAfterPush = false;
        this.advance({ "after-export.md": "A later source commit\n" });
      }
      if (this.readbackFailureOnce) {
        this.readbackFailureOnce = false;
        this.failNextReadback = true;
      }
      if (this.ambiguousOnce) {
        this.ambiguousOnce = false;
        throw new Error("Connection closed after accepted update");
      }
      return response({ object: { sha: this.head } });
    }
    throw new Error(`Unexpected mock GitHub operation: ${method} ${path}`);
  };
}
