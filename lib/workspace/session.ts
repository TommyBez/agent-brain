import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getSession } from "@/lib/auth";

export type WorkspaceUser = { id: string; name: string; email: string };

// React.cache deduplicates this check within a render, never across requests.
export const getWorkspaceUser = cache(async (): Promise<WorkspaceUser> => {
  const session = await getSession(await headers());
  if (!session) redirect("/sign-in");
  const { id, name, email } = session.user;
  return { id, name, email };
});
