"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PageSummary, PageType } from "@/lib/brain/types";
import { request } from "@/lib/request";

export function useDuplicateCheck(
  title: string,
  type: PageType,
  enabled: boolean,
) {
  const [duplicates, setDuplicates] = useState<PageSummary[]>([]);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const reset = useCallback(() => {
    controller.current?.abort();
    setDuplicates([]);
    setError("");
  }, []);
  useEffect(() => {
    reset();
    if (!enabled || title.trim().length < 3) return;
    const active = new AbortController();
    controller.current = active;
    const timer = setTimeout(async () => {
      try {
        const data = await request<{ candidates: PageSummary[] }>(
          `/api/brain/resolve?name=${encodeURIComponent(title)}&type=${type}`,
          { signal: active.signal },
        );
        if (!active.signal.aborted) setDuplicates(data.candidates);
      } catch (cause) {
        if (!active.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to check for duplicate pages.",
          );
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      active.abort();
    };
  }, [title, type, enabled, reset]);
  return { duplicates, error, reset };
}
