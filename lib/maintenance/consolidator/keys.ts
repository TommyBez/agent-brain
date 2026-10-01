/** Persisted names are stable across Workflow replay and cache reuse. */
export const recordKeys = {
  snapshot: (id: string) => `snapshot:${id}` as const,
  analysis: (id: string) => `analysis:${id}` as const,
  incompleteAnalysis: (id: string, snapshotId: string) =>
    `incomplete-analysis:${id}:${snapshotId}` as const,
  evaluation: (id: string) => `evaluation:${id}` as const,
  draft: (id: string) => `draft:${id}` as const,
  verification: (id: string) => `verification:${id}` as const,
  decision: (id: string) => `decision:${id}` as const,
  taskError: (id: string) => `task-error:${id}` as const,
};
export type RecordKey = ReturnType<
  (typeof recordKeys)[keyof typeof recordKeys]
>;
export function recordKind(key: RecordKey) {
  return key.slice(0, key.indexOf(":"));
}
