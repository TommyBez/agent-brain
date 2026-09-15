import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getSession } from "@/lib/auth";
import { signInHref, WORKSPACE_PATH_HEADER } from "@/lib/auth-navigation";

export type WorkspaceUser = { id: string; name: string; email: string };

// React.cache deduplicates this check within a render, never across requests.
export const getWorkspaceUser = cache(async (): Promise<WorkspaceUser> => {
  const requestHeaders = await headers();
  const session = await getSession(requestHeaders);
  if (!session) redirect(signInHref(requestHeaders.get(WORKSPACE_PATH_HEADER)));
  const { id, name, email } = session.user;
  return { id, name, email };
});
