import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fingerprint } from "../../lib/canonical-json";
import type { PromptTask } from "../../lib/maintenance/consolidator/prompts";
import type { Config, Example, Proposal, Splits } from "./types";

export type ModelInfo = {
  id: string;
  pricing: { input: string; output: string };
  [key: string]: unknown;
};
export type Manifest = {
  version: 1;
  id: string;
  createdAt: string;
  config: Config;
  dataset: Example[];
  datasetHash: string;
  splits: Splits;
  baseline: Record<PromptTask, string>;
  baselineHash: string;
  engineHash: string;
  models: ModelInfo[];
  decisionModel: string;
  inference: Record<string, unknown>;
  supervision: unknown;
};
export type SearchState = {
  tasks: Partial<
    Record<
      PromptTask,
      {
        prompt: string;
        iteration: number;
        stale: number;
        done: boolean;
        stoppedBy?: string;
        history: {
          proposal: Proposal | null;
          accepted: boolean;
          reasons: string[];
          promptHash?: string;
        }[];
      }
    >
  >;
  status: "prepared" | "searching" | "frozen" | "complete";
};
export type CallRecord = {
  id: string;
  status: "started" | "complete" | "error";
  requestHash: string;
  model: string;
  reservedTokens: number;
  reservedDollars: number;
  inputTokens?: number;
  outputTokens?: number;
  costDollars?: number;
  costSource?: "provider" | "catalog";
  latencyMs?: number;
  error?: string;
  response?: unknown;
};

export async function engineHash(root: string) {
  const paths = (await readdir(join(root, "scripts/apo")))
    .filter((p) => p.endsWith(".ts"))
    .map((p) => `scripts/apo/${p}`);
  paths.push(
    "scripts/optimize-jev.ts",
    ...[
      "prompts.ts",
      "extended-prompts.ts",
      "questions.ts",
      "decision-policy.ts",
      "jev.ts",
      "verifier.ts",
      "finding-analysis.ts",
      "analysis.ts",
      "snapshot.ts",
      "projections.ts",
    ].map((p) => `lib/maintenance/consolidator/${p}`),
    "lib/maintenance/gateway.ts",
  );
  return fingerprint(
    await Promise.all(
      paths.sort().map(async (p) => [p, await readFile(join(root, p), "utf8")]),
    ),
  );
}

export class ExperimentStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir);
  }
  path(name: string) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split("/").includes("..") ||
      name.startsWith("/")
    )
      throw new Error("Invalid artifact path");
    return join(this.dir, name);
  }
  async read<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(this.path(name), "utf8"));
  }
  async maybe<T>(name: string): Promise<T | null> {
    try {
      return await this.read<T>(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async write(name: string, value: unknown, immutable = false) {
    const path = this.path(name);
    await mkdir(dirname(path), { recursive: true });
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (immutable) {
      await writeFile(path, content, { flag: "wx" });
      return;
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { flag: "wx" });
    await rename(temp, path);
  }
  async text(name: string, content: string) {
    await writeFile(this.path(name), content);
  }
  async calls(): Promise<CallRecord[]> {
    try {
      const names = await readdir(this.path("calls"));
      return await Promise.all(
        names
          .filter((n) => n.endsWith(".json"))
          .sort()
          .map((n) => this.read<CallRecord>(`calls/${n}`)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async lock(): Promise<() => Promise<void>> {
    const path = this.path("run.lock");
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname() }),
      );
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(path, "utf8"));
      if (existing.host !== hostname())
        throw new Error("Experiment locked on another host");
      try {
        process.kill(existing.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          await rm(path);
          return this.lock();
        }
        throw e;
      }
      throw new Error("Experiment is already running");
    }
    return async () => {
      await rm(path, { force: true });
    };
  }
}

export function usage(calls: CallRecord[]) {
  return {
    calls: calls.length,
    tokens: calls.reduce(
      (n, c) =>
        n +
        (c.inputTokens !== undefined && c.outputTokens !== undefined
          ? c.inputTokens + c.outputTokens
          : c.reservedTokens),
      0,
    ),
    dollars: calls.reduce(
      (n, c) => n + (c.costDollars ?? c.reservedDollars),
      0,
    ),
    unknownCostCalls: calls.filter((c) => c.costDollars === undefined).length,
    errors: calls.filter((c) => c.status !== "complete").length,
  };
}
