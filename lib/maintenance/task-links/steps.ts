import { revalidateTasksCache } from "../../workspace/cache";
import type { AutoApplyState } from "./gate";
import {
  embedTaskVectors,
  linkTaskBatch,
  planTaskLinks,
  refreshDeterministicLinks,
  taskLinkHygiene,
  taskLinkSpend,
} from "./nightly";

// Durable steps of the task_links phase. Arguments and results are plain
// JSON; provider failures come back as a halt instead of an exception.

export async function planTaskLinksStep(ownerId: string) {
  "use step";
  return planTaskLinks(ownerId);
}

export async function embedTaskVectorsStep(ownerId: string, taskIds: string[]) {
  "use step";
  return embedTaskVectors(ownerId, taskIds);
}

export async function refreshDeterministicLinksStep(
  ownerId: string,
  runId: string,
  taskIds: string[],
  corpus: string,
) {
  "use step";
  const result = await refreshDeterministicLinks(
    ownerId,
    runId,
    taskIds,
    corpus,
  );
  const { rules, retrieval } = result;
  if (
    rules.suggested +
    rules.activated +
    rules.retracted +
    retrieval.suggested +
    retrieval.retracted
  )
    revalidateTasksCache(ownerId);
  return result;
}

export async function linkTaskBatchStep(
  ownerId: string,
  runId: string,
  taskIds: string[],
  autoApply: AutoApplyState,
  corpus: string,
) {
  "use step";
  const result = await linkTaskBatch(
    ownerId,
    runId,
    taskIds,
    autoApply,
    corpus,
  );
  if (result.suggested + result.activated + result.retracted)
    revalidateTasksCache(ownerId);
  return result;
}

export async function finishTaskLinksStep(ownerId: string, runId: string) {
  "use step";
  const [spendNano, hygiene] = await Promise.all([
    taskLinkSpend(ownerId, runId),
    taskLinkHygiene(ownerId),
  ]);
  return { spendNano, hygiene };
}
