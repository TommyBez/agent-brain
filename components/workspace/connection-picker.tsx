"use client";

import { useEffect, useId, useState } from "react";
import { request } from "@/components/brain-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { CONNECTION_PAGE_SIZE } from "@/lib/workspace/urls";

export type ConnectionChoice = { id: string; title: string };
export type ConnectionChoices = { pages: ConnectionChoice[]; total: number };

export function ConnectionPicker({
  initialChoices,
  excludeId,
  value,
  onChange,
}: {
  initialChoices: ConnectionChoices;
  excludeId?: string;
  value: ConnectionChoice | null;
  onChange: (choice: ConnectionChoice | null) => void;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState(initialChoices);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!query.trim() && offset === 0 && attempt === 0) {
      setResult(initialChoices);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query.trim(),
          sort: "title",
          limit: String(CONNECTION_PAGE_SIZE),
          offset: String(offset),
        });
        const next = await request<ConnectionChoices>(
          `/api/brain/pages?${params}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setResult(next);
      } catch {
        if (!controller.signal.aborted)
          setError("Unable to find pages. Try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, offset, initialChoices, attempt]);

  function changeOffset(next: number) {
    setOffset(next);
    setLoading(true);
    onChange(null);
  }
  const choices = result.pages.filter((page) => page.id !== excludeId);
  return (
    <div className="flex-1 min-w-0 space-y-2">
      <Label htmlFor={inputId}>Find a page to connect</Label>
      <Input
        id={inputId}
        type="search"
        maxLength={1000}
        value={query}
        placeholder="Search all pages…"
        onChange={(event) => {
          setQuery(event.target.value);
          setOffset(0);
          setLoading(true);
          setError("");
          onChange(null);
        }}
      />
      <NativeSelect
        aria-label="Page to connect"
        value={value?.id ?? ""}
        disabled={loading || Boolean(error)}
        onChange={(event) =>
          onChange(
            choices.find((page) => page.id === event.target.value) ?? null,
          )
        }
      >
        <NativeSelectOption value="">
          {loading ? "Searching…" : "Choose a page…"}
        </NativeSelectOption>
        {choices.map((page) => (
          <NativeSelectOption key={page.id} value={page.id}>
            {page.title}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => setAttempt(attempt + 1)}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div
          className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"
          aria-live="polite"
          aria-busy={loading}
        >
          <span>
            {loading
              ? "Searching all pages…"
              : `${result.total} matching pages${excludeId ? " · current page excluded from choices" : ""}`}
          </span>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Previous connection choices"
              disabled={loading || offset === 0}
              onClick={() =>
                changeOffset(Math.max(0, offset - CONNECTION_PAGE_SIZE))
              }
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Next connection choices"
              disabled={
                loading || offset + CONNECTION_PAGE_SIZE >= result.total
              }
              onClick={() => changeOffset(offset + CONNECTION_PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
