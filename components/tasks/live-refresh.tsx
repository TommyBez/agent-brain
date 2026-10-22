"use client";

import { useLiveRefresh } from "@/hooks/use-live-refresh";

/** Mount on a task view to re-render it within 10 seconds of any change. */
export function TaskLiveRefresh() {
  useLiveRefresh();
  return null;
}
