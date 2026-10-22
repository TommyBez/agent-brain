import type { Database } from "../../brain/pages";

// Automatic application of Jev links: a data gate, not a release (§8.3). The
// release ships the per-role switch and the kill switch, both off. A role is
// applied automatically only when its switch is on AND every threshold holds.

export const AUTO_APPLY_ROLES = ["context", "stakeholder", "decision"] as const;
export type AutoApplyRole = (typeof AUTO_APPLY_ROLES)[number];

/** Per-role switch. Turning one on is a reviewed code change after the APO. */
export const TASK_LINK_AUTO_APPLY: Readonly<Record<AutoApplyRole, boolean>> = {
  context: false,
  stakeholder: false,
  decision: false,
};

/**
 * Precision per role on the committed task_relevance benchmark
 * (docs/benchmarks/2026-10-21-task-relevance), filled in when it is run.
 */
export const TASK_RELEVANCE_BENCHMARK: Readonly<
  Record<AutoApplyRole, number | null>
> = { context: null, stakeholder: null, decision: null };

export const AUTO_APPLY_THRESHOLDS = {
  benchmarkPrecision: 0.9,
  minReviews: 30,
  minAcceptance: 0.8,
  /** Kill switch: more than 10% of the owner's decisions are rejections. */
  killRejectionRate: 0.1,
  killWindowDays: 30,
} as const;

export interface RoleReviewMetrics {
  /** Owner decisions (accepted or rejected) on consolidator links of the role. */
  reviews: number;
  accepted: number;
  rejected: number;
  acceptance: number | null;
  /** Owner decisions inside the kill-switch window. */
  recentReviews: number;
  recentRejected: number;
  recentRejectionRate: number | null;
}

export interface RoleGate {
  role: AutoApplyRole;
  enabled: boolean;
  killed: boolean;
  reasons: string[];
  metrics: RoleReviewMetrics;
  benchmarkPrecision: number | null;
}

export type AutoApplyState = Record<AutoApplyRole, boolean>;

export const AUTO_APPLY_OFF: AutoApplyState = {
  context: false,
  stakeholder: false,
  decision: false,
};

const EMPTY_METRICS: RoleReviewMetrics = {
  reviews: 0,
  accepted: 0,
  rejected: 0,
  acceptance: null,
  recentReviews: 0,
  recentRejected: 0,
  recentRejectionRate: null,
};

/** Pure gate decision for one role; every failing condition is reported. */
export function roleGate(
  role: AutoApplyRole,
  metrics: RoleReviewMetrics,
  options: {
    switchOn?: boolean;
    benchmarkPrecision?: number | null;
  } = {},
): RoleGate {
  const switchOn = options.switchOn ?? TASK_LINK_AUTO_APPLY[role];
  const precision =
    options.benchmarkPrecision === undefined
      ? TASK_RELEVANCE_BENCHMARK[role]
      : options.benchmarkPrecision;
  const thresholds = AUTO_APPLY_THRESHOLDS;
  const killed =
    metrics.recentRejectionRate !== null &&
    metrics.recentRejectionRate > thresholds.killRejectionRate;
  const reasons: string[] = [];
  if (!switchOn) reasons.push("switch_off");
  if (precision === null || precision < thresholds.benchmarkPrecision)
    reasons.push("benchmark_precision");
  if (metrics.reviews < thresholds.minReviews) reasons.push("owner_reviews");
  if (
    metrics.acceptance === null ||
    metrics.acceptance < thresholds.minAcceptance
  )
    reasons.push("acceptance");
  if (killed) reasons.push("kill_switch");
  return {
    role,
    enabled: reasons.length === 0,
    killed,
    reasons,
    metrics,
    benchmarkPrecision: precision,
  };
}

/** Acceptance and recent rejections of consolidator links, from owner decisions. */
export async function roleReviewMetrics(
  db: Database,
  ownerId: string,
): Promise<Record<AutoApplyRole, RoleReviewMetrics>> {
  const { rows } = await db.query(
    `SELECT l.role,
       count(*)::int AS reviews,
       count(*) FILTER (WHERE l.status = 'active')::int AS accepted,
       count(*) FILTER (WHERE l.status = 'rejected')::int AS rejected,
       count(*) FILTER (WHERE l.decided_at > now() - make_interval(days => $2))::int AS recent,
       count(*) FILTER (WHERE l.status = 'rejected' AND l.decided_at > now() - make_interval(days => $2))::int AS recent_rejected
     FROM brain_task_links l
     JOIN brain_agents a ON a.owner_id = l.owner_id AND a.id = l.decided_by_agent_id AND a.kind = 'owner'
     WHERE l.owner_id = $1 AND l.origin = 'consolidator' AND l.decided_at IS NOT NULL
       AND l.status IN ('active', 'rejected')
     GROUP BY l.role`,
    [ownerId, AUTO_APPLY_THRESHOLDS.killWindowDays],
  );
  const metrics = {} as Record<AutoApplyRole, RoleReviewMetrics>;
  for (const role of AUTO_APPLY_ROLES) {
    const row = rows.find((candidate) => candidate.role === role);
    metrics[role] = row
      ? {
          reviews: row.reviews,
          accepted: row.accepted,
          rejected: row.rejected,
          acceptance: row.reviews ? row.accepted / row.reviews : null,
          recentReviews: row.recent,
          recentRejected: row.recent_rejected,
          recentRejectionRate: row.recent
            ? row.recent_rejected / row.recent
            : null,
        }
      : { ...EMPTY_METRICS };
  }
  return metrics;
}

export async function autoApplyGates(
  db: Database,
  ownerId: string,
): Promise<RoleGate[]> {
  const metrics = await roleReviewMetrics(db, ownerId);
  return AUTO_APPLY_ROLES.map((role) => roleGate(role, metrics[role]));
}

export function autoApplyState(gates: RoleGate[]): AutoApplyState {
  return Object.fromEntries(
    AUTO_APPLY_ROLES.map((role) => [
      role,
      gates.some((gate) => gate.role === role && gate.enabled),
    ]),
  ) as AutoApplyState;
}
