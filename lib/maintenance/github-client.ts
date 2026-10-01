import { retryAfterMilliseconds } from "../retry-after";
export class GitHubExportError extends Error {
  readonly retryAfterMs: number | null;
  readonly retryable?: boolean;

  constructor(
    message: string,
    public status?: number,
    options: { retryAfterMs?: number | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "GitHubExportError";
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable;
  }
}

export type TreeEntry = {
  path: string;
  type: string;
  mode: string;
  sha: string;
};
export type Tree = { sha: string; tree: TreeEntry[]; truncated?: boolean };
export type Commit = { sha: string; message: string; tree: { sha: string } };
function retryOptions(response: Response) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 && (retryAfter !== null || remaining === "0"));
  const delays: number[] = [];
  const delay = retryAfterMilliseconds(retryAfter);
  if (delay !== null) delays.push(delay);
  const reset = response.headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset?.trim()) {
    const timestamp = Number(reset);
    const delay = timestamp * 1000 - Date.now();
    if (Number.isFinite(delay) && timestamp >= 0)
      delays.push(Math.max(0, delay));
  }
  return {
    retryable:
      rateLimited || response.status === 408 || response.status >= 500
        ? true
        : response.status === 403
          ? false
          : undefined,
    retryAfterMs: delays.length
      ? Math.max(...delays)
      : rateLimited
        ? 60_000
        : null,
  };
}

export function objectSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/.test(value))
    throw new GitHubExportError("GitHub returned an invalid Git object ID.");
  return value;
}
export function validBranch(branch: string) {
  return (
    Boolean(branch) &&
    !/[\s~^:?*[\\]/.test(branch) &&
    [...branch].every(
      (character) =>
        character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    ) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    branch
      .split("/")
      .every(
        (part) =>
          part &&
          !part.startsWith(".") &&
          !part.endsWith(".") &&
          !part.endsWith(".lock"),
      )
  );
}

export function createGitTreeClient(options: {
  repository: string;
  branch: string;
  token: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}) {
  const { repository, branch, token } = options;
  const requestFetch = options.fetch ?? fetch;
  const apiRoot = `https://api.github.com/repos/${repository}`;
  async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(30_000);
      response = await requestFetch(`${apiRoot}${path}`, {
        method,
        redirect: "error",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal
          ? AbortSignal.any([options.signal, timeout])
          : timeout,
      });
    } catch {
      throw new GitHubExportError(
        `GitHub ${method} request failed; publication may require readback.`,
      );
    }
    if (!response.ok) {
      const retry = retryOptions(response);
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubExportError(
        `GitHub ${method} returned HTTP ${response.status}.`,
        response.status,
        retry,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubExportError("GitHub returned an invalid JSON response.");
    }
  }

  const treeCache = new Map<string, Tree>();
  async function tree(sha: string) {
    objectSha(sha);
    const cached = treeCache.get(sha);
    if (cached) return cached;
    const value = await api<Tree>(`/git/trees/${sha}`);
    if (value.truncated || !Array.isArray(value.tree))
      throw new GitHubExportError("GitHub returned an incomplete export tree.");
    treeCache.set(sha, value);
    return value;
  }
  async function blobText(entry: TreeEntry) {
    if (entry.type !== "blob" || entry.mode !== "100644")
      throw new GitHubExportError("Export metadata must be a regular file.");
    const blob = await api<{ content: string; encoding: string }>(
      `/git/blobs/${objectSha(entry.sha)}`,
    );
    if (blob.encoding !== "base64" || typeof blob.content !== "string")
      throw new GitHubExportError("GitHub returned invalid export metadata.");
    return Buffer.from(blob.content, "base64").toString("utf8");
  }
  async function subtree(parent: Tree, name: string) {
    const entry = parent.tree.find((entry) => entry.path === name);
    if (!entry) return undefined;
    if (entry.type !== "tree" || entry.mode !== "040000")
      throw new GitHubExportError("An export directory is not a Git tree.");
    return tree(entry.sha);
  }
  const refPath = `heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  async function head() {
    const ref = await api<{
      ref: string;
      object: { type: string; sha: string };
    }>(`/git/ref/${refPath}`);
    if (ref.ref !== `refs/heads/${branch}` || ref.object?.type !== "commit")
      throw new GitHubExportError(
        "GitHub did not return the configured branch.",
      );
    return objectSha(ref.object.sha);
  }
  const blobs = new Map<string, Promise<string>>();
  function createBlob(content: string) {
    let promise = blobs.get(content);
    if (!promise) {
      promise = api<{ sha: string }>("/git/blobs", "POST", {
        content,
        encoding: "utf-8",
      }).then((value) => objectSha(value.sha));
      blobs.set(content, promise);
    }
    return promise;
  }
  async function createTree(
    entries: ({ path: string; type: string; mode: string } & (
      | { sha: string | null }
      | { content: string }
    ))[],
    base?: string,
  ) {
    return objectSha(
      (
        await api<{ sha: string }>("/git/trees", "POST", {
          ...(base ? { base_tree: base } : {}),
          tree: entries,
        })
      ).sha,
    );
  }
  return {
    api,
    tree,
    subtree,
    blobText,
    head,
    refPath,
    createBlob,
    createTree,
  };
}
