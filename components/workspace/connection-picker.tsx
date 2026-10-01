"use client";

import { ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { request } from "@/lib/request";
import { CONNECTION_PAGE_SIZE } from "@/lib/workspace/urls";

export type ConnectionChoice = { id: string; title: string };
export type ConnectionChoices = { pages: ConnectionChoice[]; total: number };

type Search = { query: string; offset: number; attempt: number };

function useConnectionChoices(
  input: string,
  initialChoices: ConnectionChoices,
) {
  const [search, setSearch] = useState<Search>({
    query: "",
    offset: 0,
    attempt: 0,
  });
  const [result, setResult] = useState(initialChoices);
  const [status, setStatus] = useState<"ready" | "loading" | "error">("ready");
  const query = input.trim();

  useEffect(() => {
    const timer = setTimeout(
      () =>
        setSearch((current) =>
          current.query === query ? current : { query, offset: 0, attempt: 0 },
        ),
      250,
    );
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    // The server already rendered the first alphabetical choices.
    if (!search.query && !search.offset && !search.attempt) {
      setResult(initialChoices);
      setStatus("ready");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    const params = new URLSearchParams({
      q: search.query,
      sort: "title",
      limit: String(CONNECTION_PAGE_SIZE),
      offset: String(search.offset),
    });
    request<ConnectionChoices>(`/api/brain/pages?${params}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (controller.signal.aborted) return;
        setResult((current) =>
          search.offset
            ? { pages: [...current.pages, ...next.pages], total: next.total }
            : next,
        );
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [search, initialChoices]);

  return {
    result,
    loading: status === "loading" || query !== search.query,
    failed: status === "error",
    retry: () =>
      setSearch((current) => ({ ...current, attempt: current.attempt + 1 })),
    more: () =>
      setSearch((current) => ({ ...current, offset: result.pages.length })),
  };
}

export function ConnectionPicker({
  id,
  initialChoices,
  excludeId,
  value,
  onChange,
}: {
  id?: string;
  initialChoices: ConnectionChoices;
  excludeId?: string;
  value: ConnectionChoice | null;
  onChange: (choice: ConnectionChoice | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const { result, loading, failed, retry, more } = useConnectionChoices(
    input,
    initialChoices,
  );
  const choices = result.pages.filter((page) => page.id !== excludeId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={`truncate ${value ? "" : "text-muted-foreground"}`}>
            {value?.title ?? "Choose a page…"}
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-72 gap-0 p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={input}
            onValueChange={setInput}
            placeholder="Search all pages…"
            maxLength={1000}
          />
          <CommandList>
            {!loading && !failed && (
              <CommandEmpty>No pages match this search.</CommandEmpty>
            )}
            <CommandGroup>
              {choices.map((page) => (
                <CommandItem
                  key={page.id}
                  value={page.id}
                  data-checked={value?.id === page.id}
                  onSelect={() => {
                    onChange(page);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{page.title}</span>
                </CommandItem>
              ))}
              {!loading && result.pages.length < result.total && (
                <CommandItem
                  value="show-more"
                  className="text-muted-foreground"
                  onSelect={more}
                >
                  Show more pages
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            {failed ? (
              <span role="alert" className="text-destructive">
                Unable to find pages.{" "}
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto p-0 text-xs"
                  onClick={retry}
                >
                  Retry
                </Button>
              </span>
            ) : (
              <output className="flex items-center gap-2">
                {loading ? (
                  <>
                    <Spinner aria-hidden="true" className="size-3" />
                    Searching all pages…
                  </>
                ) : (
                  `${result.total} matching ${result.total === 1 ? "page" : "pages"}${excludeId ? " · this page excluded" : ""}`
                )}
              </output>
            )}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
