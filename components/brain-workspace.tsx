"use client";

import {
  Activity as ActivityIcon,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  FolderOpen,
  Layers,
  LoaderCircle,
  LogOut,
  Menu,
  Network,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { authClient } from "@/lib/auth-client";
import { AgentSettings, Operations } from "./brain-settings";
import {
  type Activity,
  entityTypes,
  type PageSummary,
  relativeTime,
  request,
  type Stats,
} from "./brain-types";
import { KnowledgeGraph } from "./knowledge-graph";
import { PageDetail } from "./page-detail";

const typeIcons = {
  person: Users,
  client: Building2,
  project: FolderOpen,
  article: FileText,
  decision: Check,
  note: CircleHelp,
};
type View = "pages" | "graph" | "activity" | "agents" | "operations";
export function EntityIcon({
  type,
  size = 17,
}: {
  type: string;
  size?: number;
}) {
  const Icon = typeIcons[type as keyof typeof typeIcons] ?? FileText;
  return <Icon size={size} strokeWidth={1.6} />;
}

export function BrainWorkspace({
  name,
  email,
  mcpEndpoint,
}: {
  name: string;
  email: string;
  mcpEndpoint: string;
}) {
  const [view, setView] = useState<View>("pages");
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [sort, setSort] = useState("updated");
  const searchRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  useEffect(() => {
    const page = new URL(window.location.href).searchParams.get("page");
    if (page) setSelected(page);
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setView("pages");
        setSelected(null);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        setBusy(true);
        setError("");
        try {
          const data = await request<{ pages: PageSummary[]; total: number }>(
            `/api/brain/pages?${new URLSearchParams({ q: query, type, limit: "100", refresh: String(reload) })}`,
            { signal: controller.signal },
          );
          setPages(data.pages);
          setTotal(data.total);
        } catch (cause) {
          if (!controller.signal.aborted)
            setError(
              cause instanceof Error ? cause.message : "Unable to load pages.",
            );
        } finally {
          if (!controller.signal.aborted) setBusy(false);
        }
      },
      query ? 220 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [type, query, reload]);
  useEffect(() => {
    const controller = new AbortController();
    request<{ stats: Stats; activity: Activity[] }>(
      `/api/brain/overview?refresh=${reload}`,
      {
        signal: controller.signal,
      },
    )
      .then((data) => {
        setStats(data.stats);
        setActivity(data.activity);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load workspace.",
          );
      });
    return () => controller.abort();
  }, [reload]);
  function navigate(next: View, nextType = "") {
    setView(next);
    setType(nextType);
    setSelected(null);
    setCreating(false);
    setSidebar(false);
    window.history.replaceState(null, "", "/");
  }
  function openPage(id: string) {
    setSelected(id);
    setCreating(false);
    setView("pages");
    window.history.replaceState(null, "", `/?page=${encodeURIComponent(id)}`);
  }
  const sortedPages = [...pages].sort((a, b) =>
    sort === "title"
      ? a.title.localeCompare(b.title)
      : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const title = type
    ? (entityTypes.find((t) => t.id === type)?.label ?? "Pages")
    : "All pages";
  return (
    <div className="workspace flex min-h-[100svh]">
      <a
        href="#main-content"
        className="skip-link fixed z-[100] top-[-60px] left-[16px] p-[10px_16px] bg-foreground text-white"
      >
        Skip to content
      </a>
      {sidebar && (
        <Button
          type="button"
          variant="ghost"
          className="sidebar-scrim h-auto w-auto max-[740px]:fixed max-[740px]:[inset:0] max-[740px]:[background:#25371945] max-[740px]:z-[25]"
          onClick={() => setSidebar(false)}
          aria-label="Close navigation"
        />
      )}
      <aside
        className={`sidebar w-61 [background:var(--sidebar)] [border-right:1px_solid_var(--line)] p-[28px_20px_0] fixed [inset:0_auto_0_0] flex flex-col z-[30] overflow-y-auto max-[1200px]:w-55 max-[1200px]:pl-[15px] max-[1200px]:pr-[15px] max-[960px]:w-[194px] max-[960px]:pl-3 max-[960px]:pr-3 max-[740px]:w-61 max-[740px]:[transform:translateX(-100%)] max-[740px]:[transition:transform_.2s_ease] max-[740px]:[box-shadow:10px_0_35px_#2938200b] ${sidebar ? "is-open" : ""}`}
      >
        <a
          className="wordmark flex items-center gap-[11px] [font-family:var(--serif)] [font-size:31px] font-semibold tracking-[-1.2px]"
          href="/"
          aria-label="Brain home"
        >
          <span className="brand-mark inline-flex w-[37px] h-[37px] rounded-[11px] bg-primary items-center justify-center text-background [font-family:var(--serif)] [font-size:34px] leading-[1] pb-[6px] tracking-[-3px] pr-[3px]">
            b.
          </span>{" "}
          brain
        </a>
        <div className="workspace-name flex items-center gap-[9px] p-[12px_10px] [border:1px_solid_#dbdfd0] rounded-[6px] [background:#f6f6f0] mb-[22px] max-[960px]:p-[10px_7px] max-[960px]:gap-[6px]">
          <span className="workspace-monogram w-[29px] h-[29px] rounded-[6px] flex items-center justify-center [background:#e4e9db] text-primary [font-family:var(--serif)] [font-size:17px]">
            {name?.slice(0, 1).toUpperCase() || "B"}
          </span>
          <div>
            <strong>Personal brain</strong>
            <span>Your private knowledge</span>
          </div>
          <span
            className="status-dot w-[6px] h-[6px] rounded-full [background:#7c916b] [display:inline-block] shrink-0"
            title="Private workspace"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          className="sidebar-search h-auto justify-start flex items-center w-full gap-2 bg-transparent [color:#838a77] text-left [font-size:11px] p-[0_9px] mb-7"
          onClick={() => {
            navigate("pages");
            requestAnimationFrame(() => searchRef.current?.focus());
          }}
        >
          <Search size={15} /> Find anything <kbd>⌘ K</kbd>
        </Button>
        <nav aria-label="Workspace navigation">
          <span className="nav-label block [color:#979e8c] [font-size:8px] font-semibold tracking-[.16em] p-[0_10px] mb-[10px]">
            WORKSPACE
          </span>
          <Button
            type="button"
            variant="ghost"
            className={`nav-item justify-start flex items-center w-full gap-[10px] bg-transparent p-[10px_11px] rounded-[5px] [color:#717968] [font-size:11px] text-left m-[2px_0] min-h-[36px] [transition:background_.12s] ${view === "pages" && !type ? "active" : ""}`}
            onClick={() => navigate("pages")}
          >
            <BookOpen size={17} /> All pages <span>{stats?.pages ?? "—"}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`nav-item justify-start flex items-center w-full gap-[10px] bg-transparent p-[10px_11px] rounded-[5px] [color:#717968] [font-size:11px] text-left m-[2px_0] min-h-[36px] [transition:background_.12s] ${view === "graph" ? "active" : ""}`}
            onClick={() => navigate("graph")}
          >
            <Network size={17} /> Knowledge graph
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`nav-item justify-start flex items-center w-full gap-[10px] bg-transparent p-[10px_11px] rounded-[5px] [color:#717968] [font-size:11px] text-left m-[2px_0] min-h-[36px] [transition:background_.12s] ${view === "activity" ? "active" : ""}`}
            onClick={() => navigate("activity")}
          >
            <ActivityIcon size={17} /> Activity
          </Button>
          <span className="nav-label block [color:#979e8c] [font-size:8px] font-semibold tracking-[.16em] p-[0_10px] mb-[10px] collection-label mt-[27px]">
            COLLECTIONS
          </span>
          {entityTypes.map((item) => (
            <Button
              type="button"
              variant="ghost"
              key={item.id}
              className={`nav-item justify-start flex items-center w-full gap-[10px] bg-transparent p-[10px_11px] rounded-[5px] [color:#717968] [font-size:11px] text-left m-[2px_0] min-h-[36px] [transition:background_.12s] ${view === "pages" && type === item.id ? "active" : ""}`}
              onClick={() => navigate("pages", item.id)}
            >
              <EntityIcon type={item.id} />
              {item.label}
              <span>{stats?.byType[item.id] ?? 0}</span>
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom mt-auto pt-[35px] max-[1200px]:pt-[22px]">
          <div className="agent-note [border:1px_solid_#dbe0d1] rounded-[6px] p-[16px_13px] [background:#eaeedf] m-[0_4px_22px] max-[1200px]:hidden">
            <span className="agent-note-icon block [color:#778b62] mb-[9px]">
              <Bot size={18} />
            </span>
            <strong>Made to think together.</strong>
            <p>Give your agent a place to remember.</p>
            <Button
              type="button"
              variant="ghost"
              className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
              onClick={() => navigate("agents")}
            >
              Connect an agent <ArrowUpRight size={14} />
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            className={`nav-item justify-start flex items-center w-full gap-[10px] bg-transparent p-[10px_11px] rounded-[5px] [color:#717968] [font-size:11px] text-left m-[2px_0] min-h-[36px] [transition:background_.12s] ${view === "agents" ? "active" : ""}`}
            onClick={() => navigate("agents")}
          >
            <Bot size={17} /> Agents & access
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`nav-item justify-start flex items-center w-full gap-[10px] bg-transparent p-[10px_11px] rounded-[5px] [color:#717968] [font-size:11px] text-left m-[2px_0] min-h-[36px] [transition:background_.12s] ${view === "operations" ? "active" : ""}`}
            onClick={() => navigate("operations")}
          >
            <Settings2 size={17} /> Operations
          </Button>
          <div className="profile flex items-center gap-[9px] [border-top:1px_solid_#dce1d1] mt-[19px] p-[19px_1px_21px]">
            <div className="profile-avatar w-[29px] h-[29px] shrink-0 rounded-full [background:#e0e5d5] [color:#6d7e5d] [font-family:var(--serif)] flex items-center justify-center [font-size:15px]">
              {name?.slice(0, 1).toUpperCase() || "B"}
            </div>
            <div>
              <strong>{name || "Workspace owner"}</strong>
              <span title={email}>{email}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="icon-button bg-transparent w-[30px] h-[30px] rounded-[5px] inline-flex items-center justify-center text-muted-foreground shrink-0"
              aria-label="Sign out"
              onClick={async () => {
                await authClient.signOut();
                window.location.assign("/");
              }}
            >
              <LogOut size={16} />
            </Button>
          </div>
        </div>
      </aside>
      <div className="main-shell ml-61 w-[calc(100%_-_244px)] min-w-0 max-[1200px]:ml-55 max-[1200px]:w-[calc(100%_-_220px)] max-[960px]:ml-[194px] max-[960px]:w-[calc(100%_-_194px)] max-[740px]:ml-[0] max-[740px]:w-full">
        <header className="topbar h-17 flex items-center justify-between [border-bottom:1px_solid_var(--line)] p-[0_42px] max-[1200px]:p-[0_30px] max-[960px]:p-[0_25px] max-[740px]:justify-start max-[740px]:h-15 max-[740px]:p-[0_23px] max-[460px]:pl-[18px] max-[460px]:pr-[18px]">
          <Button
            type="button"
            variant="ghost"
            className="icon-button bg-transparent w-[30px] h-[30px] rounded-[5px] inline-flex items-center justify-center text-muted-foreground shrink-0 mobile-menu hidden max-[740px]:flex max-[740px]:ml-[-5px] max-[740px]:mr-[10px]"
            aria-label="Open navigation"
            onClick={() => setSidebar(true)}
          >
            <Menu size={20} />
          </Button>
          <div className="breadcrumb flex items-center gap-[15px] [font-size:10px] [color:#8e9485] max-[740px]:gap-2 max-[740px]:[font-size:9px]">
            Personal brain <ChevronRight size={13} />
            <span>
              {view === "pages"
                ? selected
                  ? "Page"
                  : creating
                    ? "New page"
                    : title
                : view === "graph"
                  ? "Knowledge graph"
                  : view === "agents"
                    ? "Agents & access"
                    : view === "operations"
                      ? "Operations"
                      : "Activity"}
            </span>
          </div>
          <span className="private-label flex items-center gap-[7px] [color:#8b947e] [font-size:8px] tracking-[.13em] max-[960px]:[font-size:7px] max-[740px]:ml-auto max-[460px]:[font-size:0]">
            <span className="status-dot w-[6px] h-[6px] rounded-full [background:#7c916b] [display:inline-block] shrink-0" />{" "}
            PRIVATE WORKSPACE
          </span>
        </header>
        <main
          id="main-content"
          className={`main-content max-w-[1390px] p-[46px_50px_25px] m-[0_auto] [animation:enter_.35s_ease-out] min-[1600px]:pt-15 max-[1200px]:p-[36px_30px_25px] max-[960px]:p-[31px_25px_23px] max-[740px]:p-[30px_23px_23px] max-[460px]:pl-[18px] max-[460px]:pr-[18px] ${selected || creating ? "detail-content" : ""}`}
        >
          {selected || creating ? (
            <PageDetail
              key={selected ? `${selected}-${reload}` : "new"}
              id={selected}
              initialType={type}
              onBack={() => navigate("pages", type)}
              onOpen={openPage}
              onSaved={(id) => {
                refresh();
                openPage(id);
              }}
            />
          ) : view === "pages" ? (
            <>
              <div className="page-heading flex items-center justify-between gap-5 mb-[35px] min-[1600px]:mb-[45px] max-[740px]:mb-7 max-[460px]:gap-[10px]">
                <div>
                  <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
                    THE KNOWLEDGE DESK
                  </span>
                  <h1>
                    {title}
                    <span className="heading-dot [color:#839567]">.</span>
                  </h1>
                  <p>
                    {type
                      ? `Your ${title.toLowerCase()}, with the context that matters.`
                      : "Everything you know. A little more connected."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="default"
                  className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap primary"
                  onClick={() => {
                    setCreating(true);
                    setSelected(null);
                  }}
                >
                  <Plus size={16} /> New page
                </Button>
              </div>
              <div className="workspace-stats grid grid-cols-[1fr_1fr_1fr_1.25fr] [border:1px_solid_var(--line)] rounded-[7px] [background:#f8f8f0] mb-[35px] p-[23px_0] max-[1200px]:grid-cols-[repeat(3,1fr)] max-[740px]:mb-[26px] max-[740px]:p-[19px_0]">
                <div>
                  <span>Pages in your brain</span>
                  <strong>
                    {stats?.pages ?? "—"}
                    <BookOpen size={19} />
                  </strong>
                </div>
                <div>
                  <span>Connections made</span>
                  <strong>
                    {stats?.links ?? "—"}
                    <Network size={19} />
                  </strong>
                </div>
                <div>
                  <span>Versions preserved</span>
                  <strong>
                    {stats?.revisions ?? "—"}
                    <Layers size={19} />
                  </strong>
                </div>
                <div className="stats-note">
                  <span className="tiny-spark">✳</span>
                  <p>
                    A growing body of knowledge.
                    <br />
                    <strong>Always yours to keep.</strong>
                  </p>
                </div>
              </div>
              <div className="library-toolbar flex gap-[10px] items-center mb-[25px] max-[740px]:gap-[9px]">
                <Label className="search-field flex-[1] flex flex-row items-center gap-[9px] p-[0_13px] [border:1px_solid_var(--line)] rounded-[5px] [background:#fffefb] [color:#8c9580] h-[39px] max-[460px]:pl-[10px] max-[460px]:gap-[7px]">
                  <Search size={17} />
                  <span className="sr-only">Search pages</span>
                  <Input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search your knowledge…"
                  />
                  {query && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="icon-button bg-transparent w-[30px] h-[30px] rounded-[5px] inline-flex items-center justify-center text-muted-foreground shrink-0"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <X size={15} />
                    </Button>
                  )}
                </Label>
                <Label className="select-field flex flex-row items-center gap-[3px] p-[0_11px] [border:1px_solid_var(--line)] rounded-[5px] h-[39px] bg-transparent [color:#7d8672] max-[740px]:p-[0_8px]">
                  <SlidersHorizontal size={15} />
                  <span className="sr-only">Filter by page type</span>
                  <NativeSelect
                    value={type}
                    onChange={(event) => setType(event.target.value)}
                  >
                    <NativeSelectOption value="">All types</NativeSelectOption>
                    {entityTypes.map((item) => (
                      <NativeSelectOption value={item.id} key={item.id}>
                        {item.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Label>
                <Label className="select-field flex flex-row items-center gap-[3px] p-[0_11px] [border:1px_solid_var(--line)] rounded-[5px] h-[39px] bg-transparent [color:#7d8672] max-[740px]:p-[0_8px] sort-select max-[960px]:hidden">
                  <ArrowDownUp size={15} />
                  <span className="sr-only">Sort pages</span>
                  <NativeSelect
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <NativeSelectOption value="updated">
                      Last updated
                    </NativeSelectOption>
                    <NativeSelectOption value="title">
                      Title A–Z
                    </NativeSelectOption>
                  </NativeSelect>
                </Label>
              </div>
              <div className="section-caption flex items-center justify-between [color:#939c86] mb-3 [font-size:9px] tracking-[.09em]">
                <span>{query ? "SEARCH RESULTS" : "YOUR LIBRARY"}</span>
                <span>
                  {busy
                    ? "Searching…"
                    : `${total} ${total === 1 ? "page" : "pages"}`}
                </span>
              </div>
              {error ? (
                <div
                  className="message [border:1px_solid_#d9dece] [background:#edf0e5] p-[16px_18px] rounded-[6px] [font-size:13px] m-[18px_0] error"
                  role="alert"
                >
                  {error}
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
                    onClick={refresh}
                  >
                    Try again
                  </Button>
                </div>
              ) : busy && !pages.length ? (
                <Loading />
              ) : sortedPages.length ? (
                <div className="page-list [border-top:1px_solid_var(--line)]">
                  <div className="list-head [font-size:8px] [color:#9aa08e] tracking-[.12em] h-[37px] p-[0_11px] [border-bottom:1px_solid_var(--line)]">
                    <span>PAGE</span>
                    <span>TYPE</span>
                    <span>UPDATED</span>
                    <span />
                  </div>
                  {sortedPages.map((page) => (
                    <Button
                      type="button"
                      variant="ghost"
                      key={page.id}
                      className="page-row h-auto whitespace-normal w-full bg-transparent text-left p-[20px_11px] [border-bottom:1px_solid_var(--line)]! [transition:background_.15s] min-h-[97px] min-[1600px]:min-h-[105px] max-[960px]:p-[17px_5px]"
                      onClick={() => openPage(page.id)}
                    >
                      <div className="page-row-main flex gap-[15px] items-start min-w-0 max-[960px]:gap-[10px]">
                        <span
                          className={`entity-symbol w-[37px] h-10 shrink-0 flex items-center justify-center [background:#edf0e5] [border:1px_solid_#e4e7dc] rounded-[5px] [color:#7d8e67] max-[960px]:w-[31px] max-[960px]:h-[34px] entity-${page.type}`}
                        >
                          <EntityIcon type={page.type} size={19} />
                        </span>
                        <div>
                          <strong>{page.title}</strong>
                          <p>{page.summary || "Open to read this page."}</p>
                          {page.tags.length > 0 && (
                            <div className="row-tags flex gap-[6px] mt-[7px] max-[460px]:hidden">
                              {page.tags.slice(0, 3).map((tag) => (
                                <span key={tag}>{tag}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <span
                        className={`type-tag inline-flex gap-[5px] items-center [justify-self:start] [font-size:9px] p-[3px_8px] rounded-[4px] [background:#ebeee3] [color:#768566] [text-transform:capitalize] whitespace-nowrap max-[460px]:[font-size:8px] max-[460px]:p-[3px_6px] type-${page.type}`}
                      >
                        {page.type}
                      </span>
                      <time dateTime={page.updatedAt}>
                        {relativeTime(page.updatedAt)}
                      </time>
                      <ArrowUpRight
                        className="row-arrow [color:#9ba68c] opacity-[0] [transform:translate(-3px,3px)] [transition:opacity_.15s,transform_.15s]"
                        size={17}
                      />
                    </Button>
                  ))}
                  {total > pages.length && (
                    <p className="form-note [font-size:11px] text-muted-foreground font-normal leading-[1.65]">
                      Showing the first {pages.length} pages. Narrow your search
                      to find more.
                    </p>
                  )}
                </div>
              ) : (
                <Empty
                  icon={<BookOpen size={31} strokeWidth={1.2} />}
                  title={
                    query
                      ? "Nothing here, yet."
                      : "Begin with something worth remembering."
                  }
                  description={
                    query
                      ? "Try another phrase or a different collection."
                      : "Add your first page, or connect an agent and let useful knowledge emerge from your conversations."
                  }
                >
                  {!query && (
                    <div className="empty-actions flex gap-[10px] justify-center mt-7 max-[460px]:flex-col max-[460px]:max-w-[200px] max-[460px]:ml-auto max-[460px]:mr-[auto]">
                      <Button
                        type="button"
                        variant="default"
                        className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap primary"
                        onClick={() => setCreating(true)}
                      >
                        <Plus size={16} /> Create a page
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
                        onClick={() => navigate("agents")}
                      >
                        Connect an agent <ArrowRight size={15} />
                      </Button>
                    </div>
                  )}
                </Empty>
              )}
              <div className="library-footer mt-[29px] pt-[13px] flex items-center justify-between [color:#a6ad9a] [font-size:7px] tracking-[.14em] max-[740px]:[font-size:6px]">
                <span>ONE PAGE PER ENTITY. EVERY CONNECTION COUNTS.</span>
                <span>Brain / {new Date().getFullYear()}</span>
              </div>
            </>
          ) : view === "graph" ? (
            <KnowledgeGraph onOpen={openPage} />
          ) : view === "activity" ? (
            <>
              <div className="page-heading flex items-center justify-between gap-5 mb-[35px] min-[1600px]:mb-[45px] max-[740px]:mb-7 max-[460px]:gap-[10px]">
                <div>
                  <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
                    A RECORD OF CHANGE
                  </span>
                  <h1>
                    Activity
                    <span className="heading-dot [color:#839567]">.</span>
                  </h1>
                  <p>The small additions that make a lasting memory.</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
                  onClick={refresh}
                >
                  Refresh
                </Button>
              </div>
              {activity.length ? (
                <div className="activity-list [border-top:1px_solid_var(--line)]">
                  {activity.map((item) => (
                    <Button
                      type="button"
                      variant="ghost"
                      key={item.id}
                      className="activity-row h-auto whitespace-normal flex items-center gap-4 w-full bg-transparent [border-bottom:1px_solid_var(--line)]! text-left p-[22px_10px] max-[740px]:pl-[0] max-[740px]:pr-[0] max-[460px]:gap-[10px]"
                      onClick={() => openPage(item.pageId)}
                    >
                      <span className="activity-marker w-[35px] h-[35px] rounded-full [background:#e8eddf] [color:#8a9a75] flex items-center justify-center max-[460px]:w-[30px] max-[460px]:h-[30px] max-[460px]:shrink-0">
                        <FileText size={17} />
                      </span>
                      <div>
                        <strong>{item.title || "Page updated"}</strong>
                        <p>{item.reason || "Page saved"}</p>
                        <span>
                          {item.source || "Workspace"}{" "}
                          <span className="dot-separator [color:#a9ae9f] p-[0_5px]">
                            ·
                          </span>{" "}
                          Version {item.version}
                        </span>
                      </div>
                      <time>{relativeTime(item.createdAt)}</time>
                      <ChevronRight size={17} />
                    </Button>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<ActivityIcon size={31} />}
                  title="Every change has a story."
                  description="Your first saved page will appear here, with its source and version."
                />
              )}
            </>
          ) : view === "agents" ? (
            <AgentSettings endpoint={mcpEndpoint} />
          ) : (
            <Operations />
          )}
        </main>
      </div>
    </div>
  );
}

export function Loading() {
  return (
    <output className="loading-state flex justify-center items-center gap-3 [color:#839274] min-h-[210px] [font-size:12px]">
      <LoaderCircle size={20} className="spin" /> Opening your knowledge…
    </output>
  );
}
export function Empty({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="block shadow-none empty-state p-[66px_25px_77px] text-center [border:1px_solid_var(--line)] rounded-[6px] [background:#f8f9f2] max-[740px]:p-[53px_25px] max-[460px]:p-[42px_18px]">
      <span className="empty-symbol w-[71px] h-[71px] [border:1px_solid_#dce4ce] rounded-full flex items-center justify-center m-[0_auto_25px] [color:#82956d] [background:#edf1e3]">
        {icon}
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </Card>
  );
}
