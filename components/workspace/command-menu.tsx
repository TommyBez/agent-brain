"use client";

import { defaultFilter } from "cmdk";
import {
  Activity,
  BookOpen,
  Bot,
  type LucideIcon,
  Network,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { entityTypes } from "@/lib/brain/labels";
import type { PageSummary, PageType } from "@/lib/brain/types";
import { request } from "@/lib/request";
import { collectionHref, libraryHref, pageHref } from "@/lib/workspace/urls";
import { EntityIcon } from "./primitives";

type CommandMenuState = { open: boolean; setOpen: (open: boolean) => void };

const CommandMenuContext = createContext<CommandMenuState | null>(null);

export function useCommandMenu() {
  const context = useContext(CommandMenuContext);
  if (!context)
    throw new Error("useCommandMenu must be used within CommandMenuProvider.");
  return context;
}

export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function toggle(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <CommandMenuContext value={value}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search your workspace"
        description="Find a page, or jump to a collection or setting."
        className="sm:max-w-xl"
      >
        {/* Mounted only while open, so every visit starts from a clean query. */}
        <CommandMenuContent onNavigate={() => setOpen(false)} />
      </CommandDialog>
    </CommandMenuContext>
  );
}

type Destination = {
  href: string;
  label: string;
  group: "Go to" | "Collections" | "Create" | "Settings";
  icon: ReactNode;
  keywords?: string[];
  // Shown before the user types; the remaining entries appear only as matches.
  suggested: boolean;
};

function icon(Icon: LucideIcon) {
  return <Icon strokeWidth={1.6} />;
}

function entityIcon(type: PageType) {
  return (
    <EntityIcon
      type={type}
      size={16}
      className={`entity-${type} text-secondary-foreground`}
    />
  );
}

const destinations: Destination[] = [
  {
    href: "/",
    label: "All pages",
    group: "Go to",
    icon: icon(BookOpen),
    keywords: ["library", "home"],
    suggested: true,
  },
  {
    href: "/graph",
    label: "Knowledge graph",
    group: "Go to",
    icon: icon(Network),
    keywords: ["connections", "links", "network"],
    suggested: true,
  },
  {
    href: "/activity",
    label: "Activity",
    group: "Go to",
    icon: icon(Activity),
    keywords: ["recent", "changes", "history"],
    suggested: true,
  },
  ...entityTypes.map(
    (item): Destination => ({
      href: collectionHref(item.id),
      label: item.label,
      group: "Collections",
      icon: entityIcon(item.id),
      keywords: [item.singular, "collection"],
      suggested: true,
    }),
  ),
  {
    href: "/pages/new",
    label: "New page",
    group: "Create",
    icon: icon(Plus),
    keywords: ["create", "add", "write"],
    suggested: true,
  },
  ...entityTypes.map(
    (item): Destination => ({
      href: `/pages/new?type=${item.id}`,
      label: `New ${item.singular.toLowerCase()}`,
      group: "Create",
      icon: entityIcon(item.id),
      keywords: ["create", "add", item.label],
      suggested: false,
    }),
  ),
  {
    href: "/agents",
    label: "Agents & access",
    group: "Settings",
    icon: icon(Bot),
    keywords: ["mcp", "oauth", "tokens", "password"],
    suggested: true,
  },
  {
    href: "/operations",
    label: "Operations",
    group: "Settings",
    icon: icon(Settings2),
    keywords: ["maintenance", "backup", "export", "status"],
    suggested: true,
  },
];

const destinationGroups = [
  "Go to",
  "Collections",
  "Create",
  "Settings",
] as const;
const typeLabels = new Map(entityTypes.map((item) => [item.id, item]));

// cmdk scores scattered subsequences (e.g. "mar" in "Operations") near 0.1;
// word-start matches score close to 1.
const MIN_SCORE = 0.2;

function matchingDestinations(query: string) {
  if (!query) return destinations.filter((item) => item.suggested);
  return destinations
    .map((item) => ({
      item,
      score: defaultFilter(item.label, query, item.keywords),
    }))
    .filter(({ score }) => score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

async function findPages(query: string, signal: AbortSignal) {
  if (!query) {
    const recent = await request<{ pages: PageSummary[] }>(
      "/api/brain/pages?limit=6",
      { signal },
    );
    return recent.pages;
  }
  // Name resolution ranks people, companies and aliases first; the text match
  // then covers summaries and page content.
  const [named, matched] = await Promise.all([
    request<{ candidates: PageSummary[] }>(
      `/api/brain/resolve?${new URLSearchParams({ name: query.slice(0, 200) })}`,
      { signal },
    ).catch(() => ({ candidates: [] })),
    request<{ pages: PageSummary[] }>(
      `/api/brain/pages?${new URLSearchParams({ q: query, limit: "10" })}`,
      { signal },
    ),
  ]);
  const pages = new Map<string, PageSummary>();
  for (const page of [...named.candidates, ...matched.pages])
    if (!pages.has(page.id)) pages.set(page.id, page);
  return [...pages.values()].slice(0, 10);
}

type PageResults = { query: string; pages: PageSummary[]; failed: boolean };

function usePageResults(query: string) {
  const [results, setResults] = useState<PageResults | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        try {
          const pages = await findPages(query, controller.signal);
          setResults({ query, pages, failed: false });
        } catch {
          if (!controller.signal.aborted)
            setResults({ query, pages: [], failed: true });
        }
      },
      query ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  // Earlier results stay visible while the next query loads.
  return { results, loading: results?.query !== query };
}

function groupByType(pages: PageSummary[]) {
  const groups = new Map<PageType, PageSummary[]>();
  for (const page of pages)
    groups.set(page.type, [...(groups.get(page.type) ?? []), page]);
  return [...groups.entries()];
}

function CommandMenuContent({ onNavigate }: { onNavigate: () => void }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const query = input.trim().slice(0, 500);
  const { results, loading } = usePageResults(query);
  const matches = matchingDestinations(query);
  const showsPages = Boolean(query || results?.pages.length);

  function go(href: string) {
    onNavigate();
    router.push(href);
  }

  function pageItem(page: PageSummary, detail?: string) {
    return (
      <CommandItem
        key={page.id}
        value={`page:${page.id}`}
        onSelect={() => go(pageHref(page.id))}
      >
        {entityIcon(page.type)}
        <span className="min-w-0 flex-1 truncate">{page.title}</span>
        {detail && (
          <CommandShortcut className="tracking-normal">
            {detail}
          </CommandShortcut>
        )}
      </CommandItem>
    );
  }

  const status = loading
    ? "Searching…"
    : results?.failed
      ? "Unable to search pages. Try again."
      : query && !results?.pages.length
        ? `No pages match “${query}”.`
        : "";

  return (
    <Command shouldFilter={false} loop>
      <CommandInput
        value={input}
        onValueChange={setInput}
        placeholder="Search pages, people, companies…"
        maxLength={500}
      />
      <output className="flex min-h-7 items-center gap-2 px-3 text-xs text-muted-foreground empty:min-h-0">
        {status && (
          <>
            {loading && <Spinner aria-hidden="true" className="size-3" />}
            {status}
          </>
        )}
      </output>
      <CommandList className="max-h-[min(26rem,60svh)]">
        {results && !results.query && results.pages.length > 0 && (
          <CommandGroup heading="Recent pages">
            {results.pages.map((page) =>
              pageItem(page, typeLabels.get(page.type)?.singular),
            )}
          </CommandGroup>
        )}
        {results?.query &&
          groupByType(results.pages).map(([type, pages]) => (
            <CommandGroup key={type} heading={typeLabels.get(type)?.label}>
              {pages.map((page) => pageItem(page))}
            </CommandGroup>
          ))}
        {query && (
          <CommandGroup>
            <CommandItem
              value={`search:${query}`}
              onSelect={() => go(libraryHref({ query }))}
            >
              <Search strokeWidth={1.6} />
              <span className="min-w-0 flex-1 truncate">
                Show all pages matching “{query}”
              </span>
            </CommandItem>
          </CommandGroup>
        )}
        {showsPages && matches.length > 0 && <CommandSeparator />}
        {destinationGroups.map((group) => {
          const items = matches.filter((item) => item.group === group);
          if (!items.length) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={`go:${item.href}`}
                  onSelect={() => go(item.href)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
      <div className="flex items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground max-sm:hidden">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          to open
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Kbd>esc</Kbd>
          to close
        </span>
      </div>
    </Command>
  );
}
