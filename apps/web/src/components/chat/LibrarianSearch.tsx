"use client";

// History retrieval owns its query and adopted prefix. Message text is immutable;
// explicit refresh adopts new ranking, while returning keeps the inspected order.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { ExcerptText } from "@/components/resources/ResourceBody";
import DiscoveryTail from "@/components/collections/DiscoveryTail";
import { nearDiscoveryTail, useInitialDiscoveryDemand } from "@/lib/search/discoveryBoundary";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useServerList, type ListSnapshot, type ServerList } from "@/lib/api/useServerList";
import type { ApiJson } from "@/lib/api/wire";
import { librarianSearchQuery } from "@/lib/panes/indexPaneQuery";
import { truncatePaneSearchQuery, type PaneQuery } from "@/lib/panes/paneChrome";
import { publishPaneScroll } from "@/lib/panes/paneScroll";
import { requirePaneRuntime, usePaneIsVisible, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import { fetchSearchResultPage } from "@/lib/search/searchApi";
import { searchHref } from "@/lib/search/searchParams";
import { searchPrefixTimeoutMs } from "@/lib/search/policy";
import { useHydratedBrowserTimeZone } from "@/lib/time/browserTimeZone";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import { definePaneVisitDataKey, usePaneForwardTravel, usePaneReturnScrollport, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { parseWorkspaceHref } from "@/lib/workspace/workspaceHref";
import styles from "./LibrarianSearch.module.css";

type Row = ApiJson<"/search", "get">["results"][number];
const RESULTS = definePaneVisitDataKey<ListSnapshot<Row>>("Librarian.SearchResults");
const SELECTION = definePaneVisitDataKey<SearchActive>("Librarian.SearchSelection");
const QUERY_SETTLE_MS = 120;

export function useLibrarianSearch() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "LibrarianSearch");
  const { accountId } = useAuthenticatedAccount();
  const active = usePaneIsVisible();
  const workspace = useLatestWorkspace();
  const inputRef = useRef<HTMLInputElement>(null);
  // The shell mounts the field after its body; the ref claims entry focus there.
  const bindInput = useCallback((field: HTMLInputElement | null) => {
    inputRef.current = field;
    const delivery = runtime.paneEntryDelivery;
    if (field === null || delivery?.entry.kind !== "FocusLibrarianSearch" || !runtime.claimPaneEntryDelivery(delivery)) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(delivery.entry.start, delivery.entry.end, delivery.entry.direction);
  }, [runtime]);
  const id = useId();
  const queryText = librarianSearchQuery(runtime.href);
  const searching = queryText !== null;
  const applied = queryText ?? "";
  const entry = runtime.paneEntryDelivery?.entry;
  const [input, setInput] = useState(() => ({ applied, text: entry?.kind === "FocusLibrarianSearch" ? entry.text : applied }));
  if (input.applied !== applied) setInput({ applied, text: applied });
  const text = input.applied === applied ? input.text : applied;
  const [composing, setComposing] = useState(false);
  const previous = workspace().state.panes.find(pane => pane.id === runtime.paneId)?.history.back.at(-1);
  const previousUrl = previous ? parseWorkspaceHref(previous.href) : null;
  const previousSearch = previous !== undefined && librarianSearchQuery(previous.href) !== null;
  const hasOrigin = previousUrl?.pathname === "/librarian" && !previousSearch;
  const backToResults = !searching && previousUrl?.pathname === "/librarian" && previousSearch;
  const clear = useCallback((intent: "Clear" | "Close") => {
    setInput({ applied, text: "" });
    if (!searching) return;
    const entry = intent === "Clear" ? { kind: "FocusLibrarianSearch" as const, text: "", start: 0, end: 0, direction: "none" as const } : undefined;
    if (hasOrigin) runtime.router.back({ disposition: { kind: "Follow" }, entry });
    else runtime.router.replace("/librarian", { entry });
  }, [applied, searching, hasOrigin, runtime.router]);
  const apply = useCallback(() => {
    if (composing) return;
    const query = text.trim();
    if (!query) { clear("Clear"); return; }
    if (query === applied) return;
    const href = `/librarian?${new URLSearchParams({ q: query })}`;
    const field = inputRef.current;
    const result = searching ? runtime.router.replace(href) : runtime.router.push(href, { entry: { kind: "FocusLibrarianSearch", text,
      start: field?.selectionStart ?? text.length, end: field?.selectionEnd ?? text.length,
      direction: field?.selectionDirection ?? "none" } });
    if (result !== "cancelled") setInput({ applied: query, text });
  }, [text, applied, searching, composing, clear, inputRef, runtime.router]);
  useEffect(() => {
    if (composing || text.trim() === applied) return;
    const timer = setTimeout(apply, QUERY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text, applied, composing, apply]);
  const query: SearchQuery = { ...emptySearchQuery(), text: applied, requestedKinds: new Set(["messages"]), view: "passages" };
  const eligible = searching && Array.from(applied).length >= 2;
  const key = JSON.stringify([accountId, applied]);
  const [attempt, restart] = useState({ key, count: 0 });
  const readKey = `${key}:${attempt.key === key ? attempt.count : 0}`;
  const settled = text.trim() === applied && !composing;
  const list = useServerList<Row>({
    key: eligible ? readKey : null, stale: "", pageSize: 20, active: active && eligible && settled,
    continuation: () => true, retainPreviousKey: true,
    retry: "capacity", cursorRecovery: "manual", readPolicy: "search:lexical-prefix", prefixTimeoutMs: searchPrefixTimeoutMs,
    visit: RESULTS, id: row => row.item.ref,
    fetchPage: async (cursor, limit, signal) => {
      const page = await fetchSearchResultPage(query, { phase: "lexical", cursor, limit, signal });
      return { items: page.results, next_cursor: page.page.next_cursor };
    },
  });
  const captured = useRef<SearchActive>(null);
  const restored = usePaneVisitData(SELECTION, () => captured.current);
  const saveSelection = usePaneVisitDataWriter(SELECTION);
  const [selection, setSelection] = useState<SearchActive>(restored);
  const current = eligible && list.current && settled;
  const rows = list.current || list.shownKey?.startsWith(`${key}:`) ? list.items : [];
  const canContinue = current && !list.complete && list.failure === null;
  const options = rows.map(row => ({ key: row.item.ref, disabledReason: row.item.activation.href === null ? "message unavailable" : null }));
  const selected = reconcileSearchActive({ context: key, admitted: current, options, initialKey: rows[0]?.item.ref ?? null, active: selection });
  if (selected !== selection) setSelection(selected);
  captured.current = selected;
  const navigation = useSearchOptions<HTMLDivElement>({
    listId: `${id}-messages`, label: "matching messages", open: current, options, activeKey: selected?.key ?? null,
    onActiveChange: ref => setSelection({ context: key, key: ref }), allowShiftEnter: true,
    onForward: () => { if (canContinue) list.fetchAhead(); },
    onActivate: (ref, event) => {
      if (!current) return;
      const row = rows.find(row => row.item.ref === ref);
      const href = row?.item.activation.href;
      if (!href) return;
      const intent = workspaceTargetActivationIntent(event, "activate");
      if (intent.kind === "Unowned") return;
      event.preventDefault();
      if (intent.kind !== "Open") return;
      saveSelection({ context: key, key: ref });
      if (intent.intent === "new_pane") runtime.activateTarget({ target: { href }, disposition: { kind: "Fork" } });
      else runtime.router.push(href);
    },
  });
  const pending = eligible && !list.current && list.failure === null;
  const feedback = useCollectionReadFeedback({ list, unit: { singular: "message", plural: "messages" }, waiting: pending,
    outcome: list.current ? `${rows.length} messages shown.` : null });
  const rejected = list.failure?.error.code === "E_INVALID_CURSOR";
  const refresh = async () => {
    if (rejected) restart(value => ({ key, count: value.key === key ? value.count + 1 : 1 }));
    else await list.refetch();
    return null;
  };
  const controls: PaneQuery = { kind: "Collation", collation: {
    dimensions: [], order: null, reset: null,
    words: {
      label: "search messages", value: text, applied, input: bindInput,
      requestOpen: entry?.kind === "FocusLibrarianSearch",
      onChange: value => setInput({ applied, text: truncatePaneSearchQuery(value) }), onClear: clear,
      standing: false, onSubmit: null, rows: null, notice: null,
      field: {
        ...navigation.inputProps, "aria-keyshortcuts": "ArrowDown ArrowUp Enter Shift+Enter Escape",
        onCompositionStart: () => setComposing(true), onCompositionEnd: () => setComposing(false),
        onKeyDown: event => {
          if (event.nativeEvent.isComposing || composing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey && text.trim() !== applied) {
            event.preventDefault(); event.stopPropagation(); if (!event.repeat) apply(); return;
          }
          if (navigation.handleKey(event.nativeEvent, composing)) { event.preventDefault(); event.stopPropagation(); }
        },
      },
      verbs: [
        ...(backToResults ? [{ kind: "command" as const, id: "back-to-results", label: "back to results", icon: null,
          onSelect: () => runtime.router.back({ disposition: { kind: "Follow" } }) }] : []),
        ...(searching ? [{ kind: "link" as const, id: "search-all-nexus", label: "search all nexus", icon: null,
          href: searchHref({ ...emptySearchQuery(), text: applied }) }] : []),
      ],
    },
  } };
  return {
    searching, query: controls, ready: !eligible || list.current || list.failure !== null, refresh,
    content: searching ? <LibrarianSearchResults query={applied} eligible={eligible} list={list} current={current}
      canContinue={canContinue} refresh={() => { void refresh().catch(() => {}); }} rows={rows}
      navigation={navigation} announcement={feedback.announcement} /> : null,
  };
}

function LibrarianSearchResults({ query, eligible, list, current, canContinue, refresh, rows, navigation, announcement }: {
  query: string; eligible: boolean; list: ServerList<Row>; current: boolean;
  canContinue: boolean; refresh: () => void; rows: readonly Row[];
  navigation: ReturnType<typeof useSearchOptions<HTMLDivElement>>;
  announcement: ReturnType<typeof useCollectionReadFeedback>["announcement"];
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "LibrarianSearchResults");
  const content = useRef<HTMLDivElement>(null);
  usePaneReturnScrollport({ enabled: true, scrollportRef: navigation.listRef, contentRef: content,
    continuityKey: `${runtime.visitId}:${runtime.routeKey}` });
  useLayoutEffect(() => {
    const port = navigation.listRef.current;
    if (port) return publishPaneScroll(port);
  }, [navigation.listRef]);
  const timeZone = useHydratedBrowserTimeZone();
  usePaneForwardTravel(port => { if (canContinue && nearDiscoveryTail(port)) list.fetchAhead(); });
  useInitialDiscoveryDemand({ key: query, current: list.current, active: canContinue && list.active,
    viewport: () => navigation.listRef.current, run: list.fetchAhead });
  const failure = list.failure?.error ?? null;
  const rejected = failure?.code === "E_INVALID_CURSOR";
  const repeated = failure?.code === "E_REPEATED_CURSOR";
  return <div ref={navigation.listRef} className={styles.scrollport}>
    <div ref={content} className={styles.searchResults} data-pane-return-scope="Librarian.Search">
      {!eligible ? <Fact line={{ fact: "type at least two characters" }} />
        : failure ? <Fact line={{ fact: list.current ? "couldn’t load more messages." : "couldn’t search messages.",
          reason: repeated ? "the source repeated its continuation." : rejected ? "the ranking has changed." : undefined }}
          verbs={repeated ? undefined : [{ label: rejected ? "refresh results" : "retry", commandKey: "search librarian", busy: list.running !== null,
            run: rejected ? refresh : list.retry }]} />
        : !list.current ? rows.length === 0 ? <Ruling /> : null
        : list.complete && rows.length === 0 ? <Fact line={{ fact: `no messages match “${query}”` }} /> : null}
      <div {...navigation.listProps} className={styles.rows} aria-busy={eligible && !list.current || undefined}>
        {rows.map(row => <MessageResult key={row.item.ref} row={row} current={current}
          option={navigation.optionProps(row.item.ref)} timeZone={timeZone} />)}
      </div>
      <DiscoveryTail label="continue searching messages" action={canContinue ? list.more : null}
        busy={list.running !== null} show={rows.length === 0 || list.continuationNeedsAction} />
      {announcement}
    </div>
  </div>;
}

function MessageResult({ row, current, option, timeZone }: {
  row: Row; current: boolean; option: ReturnType<ReturnType<typeof useSearchOptions>["optionProps"]>; timeZone: string | null;
}) {
  const body = row.item.preview.body;
  // justify-defect: the message-only endpoint returns canonical message prose.
  if (body.kind !== "prose" || body.message === null) throw new Error("message search returned non-message prose");
  const message = body.message;
  const date = new Date(message.created_at);
  const year = timeZone === null ? null : new Intl.DateTimeFormat("en", { timeZone, year: "numeric" });
  const stamp = timeZone === null ? null : {
    label: new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short",
      year: year?.format(date) === year?.format(new Date()) ? undefined : "numeric" }).format(date).toLowerCase(),
    full: date.toLocaleString("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" }),
  };
  return <a {...option} href={current ? row.item.activation.href ?? undefined : undefined}
    className={styles.searchResult} tabIndex={-1} aria-disabled={!current || option["aria-disabled"]}
    data-workspace-rich-target="true" data-collection-row-id={row.item.ref} data-row-focusable="">
    <span className={styles.searchExcerpt} data-speaker={message.role}><ExcerptText excerpt={row.match?.excerpt ?? body.excerpt} match={row.match} /></span>
    <span className={styles.searchMetadata}>{message.role === "user" ? "you" : "librarian"}
      {stamp ? <> · <time dateTime={message.created_at} aria-label={stamp.full}>{stamp.label}</time></> : null}
      {message.status !== "complete" ? " · incomplete" : null}
    </span>
  </a>;
}
