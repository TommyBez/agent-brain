import { canonicalJson as json } from "../canonical-json";
import {
  type Commit,
  createGitTreeClient,
  GitHubExportError,
  objectSha,
  validBranch,
} from "./github-client";

export { GitHubExportError } from "./github-client";

type ExportPage = {
  id: string;
  slug: string;
  markdown: string;
  [key: string]: unknown;
};
type ExportLink = { sourceId: string; [key: string]: unknown };
type ExportTask = {
  number: number;
  description?: string;
  [key: string]: unknown;
};

/**
 * schemaVersion 1 has pages and links. Version 2 adds the closed tasks, which
 * are written to their own directory and never mixed into page files.
 */
export type BrainExportSnapshot = {
  schemaVersion: number;
  exportedAt: string;
  pages: ExportPage[];
  links: ExportLink[];
  tasks?: ExportTask[];
};
export type GitHubExportResult = {
  pages: number;
  links: number;
  /** Closed tasks; present when the export used schemaVersion 2. */
  tasks?: number;
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

type Receipt = {
  schemaVersion: 1 | 2;
  jobId: string;
  runDate: string;
  exportedAt: string;
  pages: number;
  links: number;
  /** Version 2 receipts only. */
  tasks?: number;
};
const marker = "Agent Brain nightly export directory\n";
const identity = {
  name: "Agent Brain",
  email: "agent-brain@users.noreply.github.com",
};

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
const isCount = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** One Markdown file per closed task, named by its number (T-42.md). */
function taskFile(task: ExportTask) {
  if (!Number.isSafeInteger(task.number) || task.number < 1)
    throw new GitHubExportError("Invalid task in the export snapshot.");
  const { description, ...fields } = task;
  const body = typeof description === "string" ? description : "";
  return {
    path: `T-${task.number}.md`,
    content: `---\n${Object.keys(fields)
      .sort()
      .map((key) => `${key}: ${json(fields[key])}`)
      .join("\n")}\n---\n${body ? `\n${body}\n` : ""}`,
  };
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
  const repository = options.repository ?? "";
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
  const withTasks = snapshot.schemaVersion === 2;
  if (
    (snapshot.schemaVersion !== 1 && !withTasks) ||
    (withTasks && !Array.isArray(snapshot.tasks))
  )
    throw new GitHubExportError("Unsupported export snapshot version.");

  const {
    api,
    tree,
    subtree,
    blobText,
    head,
    refPath,
    createBlob,
    createTree,
  } = createGitTreeClient({
    repository,
    branch,
    token,
    fetch: options.fetch,
    signal: options.signal,
  });

  // Never upload brain content before independently checking the exact private repo.
  const metadata = await api<{ private: boolean; full_name: string }>("");
  if (
    metadata.private !== true ||
    metadata.full_name?.toLowerCase() !== repository.toLowerCase()
  )
    throw new GitHubExportError(
      "Git export destination must be the configured private repository.",
    );

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
      (receipt.schemaVersion !== 1 && receipt.schemaVersion !== 2) ||
      receipt.jobId !== jobId ||
      receipt.runDate !== runDate ||
      !isCount(receipt.pages) ||
      !isCount(receipt.links) ||
      (receipt.schemaVersion === 2 && !isCount(receipt.tasks))
    )
      throw new GitHubExportError(
        "The previous export job receipt does not match this job.",
      );
    return {
      pages: receipt.pages,
      links: receipt.links,
      ...(receipt.schemaVersion === 2 ? { tasks: receipt.tasks } : {}),
      commit: objectSha(commit.sha),
      pushed: true,
      repository,
    };
  }

  const receipt: Receipt = withTasks
    ? {
        schemaVersion: 2,
        jobId,
        runDate,
        exportedAt: snapshot.exportedAt,
        pages: snapshot.pages.length,
        links: snapshot.links.length,
        tasks: snapshot.tasks?.length ?? 0,
      }
    : {
        schemaVersion: 1,
        jobId,
        runDate,
        exportedAt: snapshot.exportedAt,
        pages: snapshot.pages.length,
        links: snapshot.links.length,
      };
  const result = {
    pages: receipt.pages,
    links: receipt.links,
    ...(withTasks ? { tasks: receipt.tasks } : {}),
  };
  const pageFiles = new Map<string, string>();
  const orderedLinks = [...snapshot.links].sort((left, right) =>
    compare(json(left), json(right)),
  );
  for (const page of [...snapshot.pages].sort((left, right) =>
    compare(left.slug, right.slug),
  )) {
    if (!/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(page.slug))
      throw new GitHubExportError("Invalid page in the export snapshot.");
    const path = `${page.slug}.md`;
    const { markdown, ...fields } = page;
    const frontmatter = {
      ...fields,
      links: orderedLinks.filter((link) => link.sourceId === page.id),
    };
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
  // Version 1 snapshots know nothing about tasks and leave that directory alone.
  const taskFiles = new Map<string, string>();
  for (const task of [...(snapshot.tasks ?? [])].sort(
    (left, right) => left.number - right.number,
  )) {
    const file = taskFile(task);
    if (taskFiles.has(file.path))
      throw new GitHubExportError("Duplicate task in the export snapshot.");
    taskFiles.set(file.path, file.content);
  }
  // Inline complete files in bounded tree requests. Start a fresh tree so
  // removed pages and purged tasks disappear, then use each preceding batch as
  // the next base.
  const freshTree = async (contents: Map<string, string>) => {
    const files = [...contents.entries()];
    let built: string | undefined;
    for (let offset = 0; offset < files.length; offset += 24) {
      built = await createTree(
        files.slice(offset, offset + 24).map(([path, content]) => ({
          path,
          content,
          type: "blob",
          mode: "100644",
        })),
        built,
      );
    }
    return built;
  };
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

    const pageTree = await freshTree(pageFiles);
    const taskTree = withTasks ? await freshTree(taskFiles) : undefined;
    const previousTasks =
      withTasks && exported ? await subtree(exported, "tasks") : undefined;
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
    if (taskTree)
      entries.push({
        path: "tasks",
        type: "tree",
        mode: "040000",
        sha: taskTree,
      });
    else if (previousTasks)
      entries.push({ path: "tasks", type: "tree", mode: "040000", sha: null });
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
      return { ...result, commit, pushed: true, repository };
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
