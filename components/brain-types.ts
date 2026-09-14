export type {
  Activity,
  BrainLink,
  BrainPage,
  BrainStats as Stats,
  PageRevision as Revision,
  PageSummary,
} from "@/lib/brain/types";

import { LINK_TYPES, PAGE_TYPES, type PageType } from "@/lib/brain/types";
export type EntityType = PageType;
export const entityTypes: { id: PageType; label: string; singular: string }[] =
  PAGE_TYPES.map((id) => ({
    id,
    label: {
      person: "People",
      client: "Clients",
      project: "Projects",
      article: "Articles",
      decision: "Decisions",
      note: "Notes",
    }[id],
    singular: id.charAt(0).toUpperCase() + id.slice(1),
  }));
export const linkTypes = LINK_TYPES;
export async function request<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : (data.error?.message ??
          data.message ??
          "The request could not be completed.");
    const error = new Error(message) as Error & {
      status: number;
      code?: string;
      details?: unknown;
    };
    error.status = response.status;
    error.code = data.code;
    error.details = data.details;
    throw error;
  }
  return data as T;
}
export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
export function relativeTime(value: string) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return formatDate(value);
}
