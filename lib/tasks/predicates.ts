// The claim predicates of §6.3, as SQL over alias `t`. Parameters are passed
// as placeholders so one predicate serves claim_task and list_tasks{claimable}.

/** Statuses a claim can start from: ready/triage, an expired lease, a stale question. */
export const CLAIMABLE_STATE = `(t.status IN ('ready','triage')
  OR (t.status = 'in_progress' AND t.lease_id IS NOT NULL AND t.lease_expires_at < now())
  OR (t.status = 'needs_input' AND t.input_requested_at < now() - interval '14 days'))`;

export const HUMAN_LEAD = `EXISTS (SELECT 1 FROM brain_task_parties p WHERE p.owner_id = t.owner_id
  AND p.task_id = t.id AND p.role = 'lead' AND p.kind IN ('person','group'))`;

export const PROJECT_PAUSED = `COALESCE(t.project_page_id = ANY(COALESCE((SELECT s.paused_project_ids
  FROM brain_task_settings s WHERE s.owner_id = t.owner_id), '{}'::uuid[])), false)`;

export const OPEN_BLOCKERS = `EXISTS (SELECT 1 FROM brain_task_dependencies d
  JOIN brain_tasks b ON b.owner_id = d.owner_id AND b.id = d.depends_on_task_id
  WHERE d.owner_id = t.owner_id AND d.task_id = t.id AND b.status <> 'done')`;

/** Claim by reference without an owner request. */
export function standardPredicate(agent: string, capabilities: string): string {
  return `(t.archived_at IS NULL AND NOT t.requires_human
  AND (t.approved_at IS NOT NULL OR t.created_by_agent_id = ${agent})
  AND (t.delegate_agent_id IS NULL OR t.delegate_agent_id = ${agent})
  AND (t.required_capability IS NULL OR t.required_capability = ANY(${capabilities}::text[]))
  AND ${CLAIMABLE_STATE}
  AND NOT ${HUMAN_LEAD}
  AND NOT ${PROJECT_PAUSED})`;
}

/** The queue (claim_task{next}, list_tasks{claimable}): also waits for dependencies. */
export function queuePredicate(agent: string, capabilities: string): string {
  return `(${standardPredicate(agent, capabilities)} AND NOT ${OPEN_BLOCKERS})`;
}

/**
 * Claim on the owner's explicit request: overrides approval, capability, a
 * paused project and a human lead; never an assignment to another agent,
 * requires_human, on_hold, terminal states or a live lease.
 */
export function onRequestPredicate(agent: string): string {
  return `(t.archived_at IS NULL AND NOT t.requires_human
  AND (t.delegate_agent_id IS NULL OR t.delegate_agent_id = ${agent})
  AND ${CLAIMABLE_STATE})`;
}

/** Queue order: priority, due date in the owner's time zone, age. */
export const QUEUE_ORDER = `t.priority, COALESCE(t.due_on, (t.due_at AT TIME ZONE 'Europe/Rome')::date) NULLS LAST, t.created_at, t.number`;
