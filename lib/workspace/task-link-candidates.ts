import { BrainError } from "../brain/types";
import { type GatewayCall, gatewayRequest } from "../maintenance/gateway";
import { tasksEnabledFor } from "../tasks/feature";
import { suggestTaskLinks } from "../tasks/link-candidates";

/** The UI action's authenticated read path, separated from Next request context for tests. */
export async function suggestPagesForOwner(
  input: unknown,
  requireUser: () => Promise<{ id: string }>,
  send: GatewayCall = gatewayRequest,
) {
  const user = await requireUser();
  if (!(await tasksEnabledFor(user.id)))
    throw new BrainError("TASKS_DISABLED", "Tasks are not enabled.");
  return suggestTaskLinks({ ownerId: user.id }, input, send);
}
