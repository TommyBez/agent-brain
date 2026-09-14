type ExportPage = {
  id: string;
  slug: string;
  markdown: string;
  [key: string]: unknown;
};
type ExportLink = { sourceId: string; [key: string]: unknown };

export type BrainExportSnapshot = {
  schemaVersion: number;
  exportedAt: string;
  pages: ExportPage[];
  links: ExportLink[];
};
export type GitHubExportResult = {
  pages: number;
  links: number;
  commit: string;
  pushed: true;
  repository: string;
};
export type GitHubExportOptions = {
  snapshot: BrainExportSnapshot;
  runDate: string;
  jobId: string;
  repository?: string;
  branch?: string;
  token?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

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

type TreeEntry = { path: string; type: string; mode: string; sha: string };
type Tree = { sha: string; tree: TreeEntry[]; truncated?: boolean };
type Commit = { sha: string; message: string; tree: { sha: string } };
type Receipt = {
  schemaVersion: 1;
  jobId: string;
  runDate: string;
  exportedAt: string;
  pages: number;
  links: number;
};
const marker = "Agent Brain nightly export directory\n";
const identity = {
  name: "Agent Brain",
  email: "agent-brain@users.noreply.github.com",
};

function retryOptions(response: Response) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 && (retryAfter !== null || remaining === "0"));
  const delays: number[] = [];
  if (retryAfter?.trim()) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) delays.push(delay);
  }
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

function json(value: unknown, indent?: number) {
  return JSON.stringify(
    value,
    (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    indent,
  );
}
function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function objectSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/.test(value))
    throw new GitHubExportError("GitHub returned an invalid Git object ID.");
  return value;
}
function validBranch(branch: string) {
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

/**
 * Export a fixed database snapshot without a checkout. GitHub writes immutable
 * blobs/trees/commits, then publishes one commit with a non-force ref update.
 * A per-job receipt makes a replay recover the original reachable commit even
 * after later daily exports have replaced manifest.json.
 */
export async function exportBrainToGitHub(
  options: GitHubExportOptions,
): Promise<GitHubExportResult> {
  const repository =
    options.repository ??
    process.env.BRAIN_EXPORT_REPOSITORY ??
    "TommyBez/agent-brain-memory";
  const branch = options.branch ?? process.env.BRAIN_EXPORT_BRANCH ?? "main";
  const token = options.token ?? process.env.BRAIN_EXPORT_GITHUB_TOKEN;
  if (
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !validBranch(branch)
  )
    throw new GitHubExportError(
      "Configure a valid export repository and existing branch.",
    );
  if (!token)
    throw new GitHubExportError("BRAIN_EXPORT_GITHUB_TOKEN is required.");
  const { snapshot, jobId, runDate } = options;
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(jobId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(runDate) ||
    !Number.isFinite(Date.parse(snapshot.exportedAt))
  )
    throw new GitHubExportError(
      "Export requires a stable job ID, run date, and snapshot timestamp.",
    );

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

  // Never upload brain content before independently checking the exact private repo.
  const metadata = await api<{ private: boolean; full_name: string }>("");
  if (
    metadata.private !== true ||
    metadata.full_name?.toLowerCase() !== repository.toLowerCase()
  )
    throw new GitHubExportError(
      "Git export destination must be the configured private repository.",
    );

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
  const receiptName = `${jobId}.json`;
  const receiptPath = `export/receipts/${receiptName}`;
  const message = `Brain export ${runDate}\n\nAgent-Brain-Job: ${jobId}`;
  async function replay(
    currentHead: string,
  ): Promise<GitHubExportResult | undefined> {
    const query = new URLSearchParams({
      sha: currentHead,
      path: receiptPath,
      per_page: "1",
    });
    const history = await api<{ sha: string }[]>(`/commits?${query}`);
    if (!Array.isArray(history))
      throw new GitHubExportError("GitHub returned invalid export history.");
    if (!history.length) return undefined;
    const commit = await api<Commit>(
      `/git/commits/${objectSha(history[0].sha)}`,
    );
    if (commit.message !== message)
      throw new GitHubExportError(
        "The export job receipt has been changed outside its original commit.",
      );
    const root = await tree(commit.tree.sha);
    const exported = await subtree(root, "export");
    const receipts = exported && (await subtree(exported, "receipts"));
    const entry = receipts?.tree.find((entry) => entry.path === receiptName);
    if (!entry)
      throw new GitHubExportError(
        "The previous export commit has no job receipt.",
      );
    let receipt: Receipt;
    try {
      receipt = JSON.parse(await blobText(entry)) as Receipt;
    } catch {
      throw new GitHubExportError(
        "The previous export job receipt is invalid.",
      );
    }
    if (
      receipt.schemaVersion !== 1 ||
      receipt.jobId !== jobId ||
      receipt.runDate !== runDate ||
      !Number.isSafeInteger(receipt.pages) ||
      receipt.pages < 0 ||
      !Number.isSafeInteger(receipt.links) ||
      receipt.links < 0
    )
      throw new GitHubExportError(
        "The previous export job receipt does not match this job.",
      );
    return {
      pages: receipt.pages,
      links: receipt.links,
      commit: objectSha(commit.sha),
      pushed: true,
      repository,
    };
  }

  const receipt: Receipt = {
    schemaVersion: 1,
    jobId,
    runDate,
    exportedAt: snapshot.exportedAt,
    pages: snapshot.pages.length,
    links: snapshot.links.length,
  };
  const pageFiles = new Map<string, string>();
  const orderedLinks = [...snapshot.links].sort((left, right) =>
    compare(json(left), json(right)),
  );
  for (const page of [...snapshot.pages].sort((left, right) =>
    compare(left.slug, right.slug),
  )) {
    if (
      !/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(page.slug) ||
      typeof page.markdown !== "string"
    )
      throw new GitHubExportError("Invalid page in the export snapshot.");
    const path = `${page.slug}.md`;
    if (pageFiles.has(path))
      throw new GitHubExportError(
        "Export snapshot contains duplicate page paths.",
      );
    const { markdown, ...fields } = page;
    const frontmatter = {
      ...fields,
      links: orderedLinks.filter((link) => link.sourceId === page.id),
    };
    if (
      Object.keys(frontmatter).some(
        (key) => !/^[A-Za-z][A-Za-z0-9]*$/.test(key),
      )
    )
      throw new GitHubExportError(
        "Invalid page metadata in the export snapshot.",
      );
    pageFiles.set(
      path,
      `---\n${Object.keys(frontmatter)
        .sort()
        .map(
          (key) =>
            `${key}: ${json(frontmatter[key as keyof typeof frontmatter])}`,
        )
        .join("\n")}\n---\n\n${markdown}\n`,
    );
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
  const blobEntry = (path: string, sha: string | null) => ({
    path,
    type: "blob",
    mode: "100644",
    sha,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const previousHead = await head();
    const existing = await replay(previousHead);
    if (existing) return existing;
    const parent = await api<Commit>(`/git/commits/${previousHead}`);
    const root = await tree(parent.tree.sha);
    const exported = await subtree(root, "export");
    if (exported) {
      const ownership = exported.tree.find(
        (entry) => entry.path === ".agent-brain-export",
      );
      if (!ownership || (await blobText(ownership)) !== marker)
        throw new GitHubExportError(
          "The existing export directory is not owned by Agent Brain.",
        );
    }
    const previousPages = exported && (await subtree(exported, "pages"));
    const previousReceipts = exported && (await subtree(exported, "receipts"));
    if (previousReceipts?.tree.some((entry) => entry.path === receiptName))
      throw new GitHubExportError(
        "An export receipt exists without matching commit history.",
      );

    // Inline complete pages in bounded tree requests. Start a fresh tree so
    // removed pages disappear, then use each preceding batch as the next base.
    const files = [...pageFiles.entries()];
    let pageTree: string | undefined;
    for (let offset = 0; offset < files.length; offset += 24) {
      pageTree = await createTree(
        files.slice(offset, offset + 24).map(([path, content]) => ({
          path,
          content,
          type: "blob",
          mode: "100644",
        })),
        pageTree,
      );
    }
    const entries = [
      blobEntry(".agent-brain-export", await createBlob(marker)),
      blobEntry("graph.json", await createBlob(`${json(orderedLinks, 2)}\n`)),
      blobEntry(
        "manifest.json",
        await createBlob(
          `${json({ ...receipt, schemaVersion: snapshot.schemaVersion }, 2)}\n`,
        ),
      ),
      {
        path: "receipts",
        type: "tree",
        mode: "040000",
        sha: await createTree(
          [blobEntry(receiptName, await createBlob(`${json(receipt, 2)}\n`))],
          previousReceipts?.sha,
        ),
      },
    ];
    if (pageTree)
      entries.push({
        path: "pages",
        type: "tree",
        mode: "040000",
        sha: pageTree,
      });
    else if (previousPages)
      entries.push({ path: "pages", type: "tree", mode: "040000", sha: null });
    const exportTree = await createTree(entries, exported?.sha);
    const rootTree = await createTree(
      [{ path: "export", type: "tree", mode: "040000", sha: exportTree }],
      root.sha,
    );
    const date = new Date(snapshot.exportedAt)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const committed = await api<{ sha: string }>("/git/commits", "POST", {
      message,
      tree: rootTree,
      parents: [previousHead],
      author: { ...identity, date },
      committer: { ...identity, date },
    });
    const commit = objectSha(committed.sha);
    let publishError: unknown;
    try {
      await api(`/git/refs/${refPath}`, "PATCH", { sha: commit, force: false });
    } catch (error) {
      publishError = error;
    }
    if (
      publishError instanceof GitHubExportError &&
      publishError.retryable &&
      (publishError.status === 403 || publishError.status === 429)
    )
      throw publishError;
    // A failed HTTP response can still mean the ref was updated. Read back before
    // retrying, including when another unrelated commit has advanced the branch.
    const currentHead = await head();
    if (currentHead === commit)
      return {
        pages: receipt.pages,
        links: receipt.links,
        commit,
        pushed: true,
        repository,
      };
    const published = await replay(currentHead);
    if (published) return published;
    if (
      publishError instanceof GitHubExportError &&
      publishError.status &&
      publishError.status < 500 &&
      !(
        currentHead !== previousHead && [409, 422].includes(publishError.status)
      )
    )
      throw publishError;
  }
  throw new GitHubExportError(
    "Git export could not confirm publication after three attempts; retry this job.",
  );
}
