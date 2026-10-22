import "server-only";

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getTasksEnabled } from "@/lib/workspace/tasks-data";

// Every task route is a 404 while the owner's task manager is off. The switch
// needs the session, so each route checks it in its streamed content before
// any task read, never in the static shell: the not-found UI then replaces the
// page. The shell has already been sent, so the status stays 200 with noindex.

export async function requireTasksEnabled() {
  if (!(await getTasksEnabled())) notFound();
}

/** Renders its children only once the owner's task manager is confirmed on. */
export async function RequireTasks({ children }: { children: ReactNode }) {
  await requireTasksEnabled();
  return children;
}
