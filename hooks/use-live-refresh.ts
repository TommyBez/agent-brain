"use client";

import { useRouter } from "next/navigation";
import {
  startTransition,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

// One shared poller of GET /api/tasks/changes for every mounted subscriber
// (the navigation badge, open task views). It runs only while the tab is
// visible, at the shortest interval any subscriber asked for, and stops when
// the server says the owner's task manager is off. The switch can be turned
// back on in the same tab, so a subscriber mounted later asks again.

export const LIVE_REFRESH_MS = 10_000;
export const BADGE_REFRESH_MS = 60_000;

export interface SavedViewLink {
  id: string;
  name: string;
  href: string;
}

export interface TaskSignals {
  /** null until the server answered once. */
  enabled: boolean | null;
  /** The server's opaque change cursor. */
  latest: string | null;
  needsYou: number | null;
  views: SavedViewLink[];
  /** Increases when tasks changed outside this tab's own actions. */
  revision: number;
}

const ENABLED_KEY = "agent-brain:tasks-enabled";
const SERVER_SIGNALS: TaskSignals = {
  enabled: null,
  latest: null,
  needsYou: null,
  views: [],
  revision: 0,
};

function rememberedEnabled(): boolean | null {
  try {
    const value = window.localStorage.getItem(ENABLED_KEY);
    return value === "1" ? true : null;
  } catch {
    return null;
  }
}

function remember(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(ENABLED_KEY, "1");
    else window.localStorage.removeItem(ENABLED_KEY);
  } catch {}
}

let signals: TaskSignals =
  typeof window === "undefined"
    ? SERVER_SIGNALS
    : { ...SERVER_SIGNALS, enabled: rememberedEnabled() };
const listeners = new Set<() => void>();
const subscribers = new Map<symbol, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: AbortController | null = null;
let watchingVisibility = false;

function emit(next: TaskSignals) {
  signals = next;
  for (const listener of listeners) listener();
}

async function poll(options: { full?: boolean; silent?: boolean } = {}) {
  if (signals.enabled === false || document.visibilityState !== "visible")
    return;
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  const known = options.full ? null : signals.latest;
  try {
    const response = await fetch(
      `/api/tasks/changes${known === null ? "" : `?after=${encodeURIComponent(known)}`}`,
      { cache: "no-store", signal: controller.signal },
    );
    if (response.status === 404) {
      remember(false);
      emit({ ...SERVER_SIGNALS, enabled: false });
      return;
    }
    if (!response.ok) return;
    const data = (await response.json()) as {
      latest: string;
      needsYou?: number;
      views?: SavedViewLink[];
    };
    const changed = signals.latest !== null && data.latest !== signals.latest;
    if (!signals.enabled) remember(true);
    emit({
      enabled: true,
      latest: data.latest,
      needsYou: data.needsYou ?? signals.needsYou,
      views: data.views ?? signals.views,
      revision:
        changed && !options.silent ? signals.revision + 1 : signals.revision,
    });
  } catch {
    // Offline or superseded: the next tick tries again.
  } finally {
    if (inflight === controller) inflight = null;
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!subscribers.size || signals.enabled === false) return;
  if (document.visibilityState !== "visible") return;
  const interval = Math.min(...subscribers.values());
  timer = setTimeout(async () => {
    await poll();
    schedule();
  }, interval);
}

function onVisibility() {
  if (document.visibilityState === "visible") void poll().then(schedule);
  else schedule();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forces a poll now. After the tab's own mutation pass `silent`, so the badge
 * and views update without a second refresh of the page.
 */
export function refreshTaskSignals(options: { silent?: boolean } = {}) {
  void poll({ full: true, silent: options.silent });
}

/** Shared task signals; `intervalMs` registers this caller as a poller. */
export function useTaskSignals(intervalMs?: number): TaskSignals {
  useEffect(() => {
    if (!intervalMs) return;
    const key = Symbol("task-signals");
    subscribers.set(key, intervalMs);
    if (!watchingVisibility) {
      watchingVisibility = true;
      document.addEventListener("visibilitychange", onVisibility);
    }
    if (signals.enabled === false) {
      emit({ ...SERVER_SIGNALS });
      void poll({ full: true }).then(schedule);
    } else if (signals.latest === null)
      void poll({ full: true }).then(schedule);
    else schedule();
    return () => {
      subscribers.delete(key);
      schedule();
    };
  }, [intervalMs]);
  return useSyncExternalStore(
    subscribe,
    () => signals,
    () => SERVER_SIGNALS,
  );
}

/**
 * Re-renders the current route when tasks change elsewhere (agents, other
 * tabs, nightly maintenance): polls every 10 seconds while visible and calls
 * router.refresh() only after a change.
 */
export function useLiveRefresh(intervalMs = LIVE_REFRESH_MS) {
  const router = useRouter();
  const { revision } = useTaskSignals(intervalMs);
  const seen = useRef(revision);
  useEffect(() => {
    if (revision === seen.current) return;
    seen.current = revision;
    startTransition(() => router.refresh());
  }, [revision, router]);
}
