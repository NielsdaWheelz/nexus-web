"use client";
import { excerptTextParts } from "@nexus/authored/excerpt";
import { authoredItem } from "@/lib/notes/presentation";
import { AuthoredContinuationCursorError } from "@/lib/notes/hooks";
import ExcerptDisclosure from "@/components/resources/ExcerptDisclosure";
import ResourceBody from "@/components/resources/ResourceBody";

// Two complete server-ranked lists. Hidden generations own page one; adoption
// freezes their key/stamp, then ordinary invalidation rereads the selected prefix.
// A new key remounts the results; until it adopts, the old key's rows stand dimmed and inert.
// The account database owns notes, pages, highlights and saved passages online and
// offline, including scope membership and clipped evidence. Unavailable local scope
// inputs stay explicit; only readable peers retain their remote search owner.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { feedActionFacts, type FeedActionSubject } from "@/lib/actions/inlineActions";
import { useFeedActionFacts } from "@/lib/feeds/useFeedActionFacts";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import ResourceList from "@/components/ui/ResourceList";
import ResourceIndexRow from "@/components/resources/ResourceIndexRow";
import { ResourceIndexTitle } from "@/components/resources/ResourceType";
import type { Verbs } from "@/components/feedback/stage";
import { ExcerptText } from "@/components/resources/ResourceBody";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import DiscoveryTail from "@/components/collections/DiscoveryTail";
import { writeScrollPosition } from "@/lib/collections/scrollMotion";
import { nearDiscoveryTail, useInitialDiscoveryDemand } from "@/lib/search/discoveryBoundary";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { assertNever } from "@/lib/assertNever";
import { useChangeStamp } from "@/lib/api/changes";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import type { ApiError } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { useMediaQueryRevision } from "@/lib/media/MediaSummaryProvider";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneIsActive, usePaneIsVisible, usePaneRouter, usePaneRuntime, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { PASSAGE_KINDS } from "@/lib/search/kinds";
import { effectiveSearchKinds, emptySearchQuery, searchHasSemanticFamily, type SearchQuery } from "@/lib/search/query";
import { fetchSearchResultPage, type SearchPhase } from "@/lib/search/searchApi";
import { searchHref, searchQueryFromParams, searchQueryToParams } from "@/lib/search/searchParams";
import { searchPrefixTimeoutMs } from "@/lib/search/policy";
import { definePaneVisitDataKey, PaneRefreshAnchor, usePaneForwardTravel, usePaneReturnReady, usePaneScrollMotion, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import { localSearchApplies, useLocalSearch, type LocalMatch } from "@/lib/search/localSearch";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resourceType, resourceTypeName } from "@/lib/resources/type";
import { useSearchCollation } from "./SearchControls";
import styles from "./page.module.css";

type Response = ApiJson<"/search", "get">;
type Row = Response["results"][number];
type Metadata = Pick<Response, "view" | "phase" | "semantic_status">;
type Generation = { phase: SearchPhase; key: string; stamp: string };
type Selection = { ref: string; activation: Row["item"]["activation"] };
type SearchVisit = {
  accountId: string;
  key: string;
  adopted: Generation | null;
  latched: boolean;
  attempts: Record<SearchPhase, number>;
  selection: Selection | null;
  /** A rejected continuation survives attempts and returns until page-one replacement. */
  cursorRejected: boolean;
};
const VISIT = definePaneVisitDataKey<SearchVisit>("Search.Phase");
const LEXICAL_VISIT = definePaneVisitDataKey<ListSnapshot<Row, Metadata>>("Search.Lexical");
const HYBRID_VISIT = definePaneVisitDataKey<ListSnapshot<Row, Metadata>>("Search.Hybrid");
const UNFIXABLE = ["E_INVALID_REQUEST", "E_NOT_FOUND"];
const VIEWS = [{ value: "resources", label: "resources" }, { value: "passages", label: "passages" }];
const phaseRank = { lexical: 0, hybrid: 1 };
const GROUPS = [
  { key: "exact", label: "exact matches" },
  { key: "primary", label: "resources" },
  { key: "saved", label: "saved passages" },
  { key: "inside", label: "inside sources" },
] as const;

function resourceGroup(row: Row): number | null {
  if (!("section" in row)) return null;
  const { section } = row;
  switch (section) {
    case "primary": return row.name_match === "exact" ? 0 : 1;
    case "saved": return 2;
    case "inside": return 3;
    default: return assertNever(section);
  }
}

/** What the last key showed, rows or none, so the next key can stand them dimmed until it adopts. */
type Shown = { readonly accountId: string; readonly view: SearchQuery["view"]; readonly rows: readonly Row[] };

export default function SearchPane() {
  const params = usePaneSearchParams();
  const { accountId } = useAuthenticatedAccount();
  const query = useMemo(() => searchQueryFromParams(params), [params]);
  return query === null ? <InvalidSearch /> : <SearchPaneBody query={query} accountId={accountId} />;
}

function SearchPaneBody({ query, accountId }: { query: SearchQuery; accountId: string }) {
  const router = usePaneRouter();
  const shown = useRef<Shown | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = useCallback((next: SearchQuery) => router.replace(searchHref(next)), [router]);
  const collation = useSearchCollation({ query, commit, inputRef });
  return <SearchResults key={`${accountId}:${searchQueryToParams(query)}`} query={query} accountId={accountId}
    shown={shown} inputRef={inputRef} commit={commit} collation={collation} />;
}

function InvalidSearch() {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  usePaneChrome({
    header: { kind: "Section", meta: { kind: "None" } },
    views: {
      label: "search view", value: params.get("view") ?? "resources",
      items: VIEWS,
      onSelect: value => {
        const next = new URLSearchParams(params);
        if (value === "resources") next.delete("view"); else next.set("view", value);
        router.replace(`/search${next.size ? `?${next}` : ""}`);
      },
    },
  });
  usePaneReturnReady(true);
  return <Fact line={{ fact: "search doesn’t know this link’s view or filters." }} verbs={[{ label: "reset search", commandKey: "reset search", run: () => router.replace("/search") }]} />;
}

function SearchResults({ query, accountId, shown, inputRef, commit, collation }: {
  query: SearchQuery; accountId: string; shown: RefObject<Shown | null>;
  inputRef: RefObject<HTMLInputElement | null>; commit: (next: SearchQuery) => void;
  collation: ReturnType<typeof useSearchCollation>;
}) {
  const paneId = usePaneRuntime()?.paneId;
  const visible = usePaneIsVisible();
  const active = usePaneIsActive();
  const root = useRef<HTMLDivElement>(null);
  const remoteTail = useRef<HTMLDivElement>(null);
  const localTail = useRef<HTMLDivElement>(null);
  const motion = usePaneScrollMotion();
  const viewport = () => root.current?.closest<HTMLElement>("[data-pane-content]") ?? null;
  const key = searchQueryToParams(query).toString();
  const stamp = `${useMediaQueryRevision()}:${useChangeStamp("Notes", "NoteBodies", "Metadata")}`;
  const captured = useRef<SearchVisit | null>(null);
  const restored = usePaneVisitData(VISIT, useCallback(() => captured.current, []));
  const [visit, setVisit] = useState<SearchVisit>(() => restored?.accountId === accountId && restored.key === key ? restored : {
    accountId, key, adopted: null, latched: false, attempts: { lexical: 0, hybrid: 0 }, selection: null, cursorRejected: false,
  });
  const latched = useRef(visit.latched);
  const returning = useRef(restored?.accountId === accountId);
  const wasVisible = useRef(visible);
  if (wasVisible.current && !visible) returning.current = true;
  wasVisible.current = visible;
  const [refreshPhase, setRefreshPhase] = useState<SearchPhase | null>(null);
  const [refreshError, setRefreshError] = useState<{ phase: SearchPhase; error: ApiError; shownStamp: string; failedStamp: string } | null>(null);
  captured.current = visit;
  const blank = query.text.trim().length === 0 && (
    query.view === "passages" || query.formats.length + query.authors.length + query.roles.length === 0
  );
  const effectiveKinds = effectiveSearchKinds(query);
  const unsupported = effectiveKinds.length === 0 || (query.view === "passages" && !effectiveKinds.some(kind => PASSAGE_KINDS.has(kind)));
  const enabled = visible && !blank && !unsupported;
  const hybridWanted = enabled && searchHasSemanticFamily(query);
  const live = useRef({ key, stamp });
  live.current = { key, stamp };
  const generation = (phase: SearchPhase): Generation => {
    if (refreshPhase === phase) return { phase, key: JSON.stringify([key, phase, stamp, visit.attempts[phase]]), stamp };
    if (visit.adopted?.phase === phase) return visit.adopted;
    return { phase, key: JSON.stringify([key, phase, stamp, visit.attempts[phase]]), stamp };
  };
  const selectedStamp = (phase: SearchPhase) => refreshError?.phase === phase && refreshError.failedStamp === stamp ? refreshError.shownStamp : stamp;
  const lexicalGeneration = generation("lexical");
  const hybridGeneration = generation("hybrid");
  const lexical = useServerList<Row, Metadata>({
    key: enabled ? lexicalGeneration.key : null,
    stale: visit.adopted?.key === lexicalGeneration.key ? selectedStamp("lexical") : lexicalGeneration.stamp,
    pageSize: 20, retainPreviousKey: true, active: enabled, visit: LEXICAL_VISIT,
    continuation: row => !row.item.authored_by_viewer,
    retry: "capacity", cursorRecovery: "manual", readPolicy: "search:lexical-prefix", prefixTimeoutMs: searchPrefixTimeoutMs,
    id: row => row.item.ref,
    fetchPage: async (cursor, limit, signal) => {
      const page = await fetchSearchResultPage(query, { phase: "lexical", limit, cursor, signal });
      return { items: page.results, next_cursor: page.page.next_cursor, metadata: { view: page.view, phase: page.phase, semantic_status: page.semantic_status } };
    },
  });
  const hybrid = useServerList<Row, Metadata>({
    key: hybridWanted ? hybridGeneration.key : null,
    stale: visit.adopted?.key === hybridGeneration.key ? selectedStamp("hybrid") : hybridGeneration.stamp,
    pageSize: 20, retainPreviousKey: true, active: hybridWanted, visit: HYBRID_VISIT,
    continuation: row => !row.item.authored_by_viewer,
    retry: "capacity", cursorRecovery: "manual", readPolicy: "search:hybrid-prefix", prefixTimeoutMs: searchPrefixTimeoutMs,
    id: row => row.item.ref,
    fetchPage: async (cursor, limit, signal) => {
      const page = await fetchSearchResultPage(query, { phase: "hybrid", limit, cursor, signal });
      return { items: page.results, next_cursor: page.page.next_cursor, metadata: { view: page.view, phase: page.phase, semantic_status: page.semantic_status } };
    },
  });
  const selected = visit.adopted?.phase === "hybrid" ? hybrid : lexical;
  // A phase's failure stands through its retry, so its `retry` keeps focus while busy.
  const [incidents, setIncidents] = useState<{key: string; lexical: ApiError | null; hybrid: ApiError | null}>({key, lexical: null, hybrid: null});
  const previousIncidents = incidents.key === key ? incidents : {key, lexical: null, hybrid: null};
  const observedIncident = (phase: SearchPhase, read: typeof lexical) => {
    if (read.failure !== null) return read.failure.error;
    return read.current && read.fresh && read.running === null ? null : previousIncidents[phase];
  };
  const phaseIncidents = {key, lexical: observedIncident("lexical", lexical), hybrid: observedIncident("hybrid", hybrid)};
  if (incidents.key !== key || incidents.lexical !== phaseIncidents.lexical || incidents.hybrid !== phaseIncidents.hybrid) setIncidents(phaseIncidents);

  // remote search reads synchronized projections, including a server copy of authored text.
  const incoming = useMemo(() => (visit.adopted === null ? [] : selected.items).filter(row => !row.item.authored_by_viewer)
    .map(row => "matching_passage" in row && row.matching_passage && row.matching_passage.item.authored_by_viewer ? { ...row, matching_passage: null } : row),
  [visit.adopted, selected.items]);
  const presented = useRef(incoming);
  const results = useMemo(() => {
    if (motion === "still") return incoming;
    const previous = presented.current;
    if (motion !== "travel" || incoming.length <= previous.length
      || !previous.every((row, index) => incoming[index].item.ref === row.item.ref)) return previous;
    const additions = incoming.slice(previous.length);
    if (query.view === "resources") {
      const lastGroup = previous.reduce((group, row) => Math.max(group, resourceGroup(row) ?? 0), 0);
      if (additions.some(row => (resourceGroup(row) ?? 0) < lastGroup)) return previous;
    }
    return [...previous, ...additions];
  }, [incoming, motion, query.view]);
  useLayoutEffect(() => { presented.current = results; }, [results]);
  const remoteRefs = useMemo(() => new Set(results.map(row => row.item.ref)), [results]);
  const localApplies = localSearchApplies(query);
  const local = useLocalSearch(localApplies ? query.text.trim() : null, query.requestedKinds, query.scope, visible, remoteRefs);
  const localRows = useMemo(() => (local.matches ?? []).filter(match => match.resource.authored_by_viewer || !remoteRefs.has(match.resource.ref)), [local.matches, remoteRefs]);
  const presentedLocal = useRef(localRows);
  // Scope withdrawal overrides a held presentation.
  const shownLocal = motion === "still" || local.scopeAvailable === false ? localRows : presentedLocal.current;
  useLayoutEffect(() => { presentedLocal.current = shownLocal; }, [shownLocal]);
  const list = selected;
  const actionFacts = useFeedActionFacts({ scope: `Search:${key}`,
    targets: results.flatMap(row => {
      const ref = parseResourceRef(row.item.ref);
      return (ref?.scheme === "podcast" || ref?.scheme === "feed") && row.item.preview.body.kind === "named" && !row.item.missing
        ? [{ kind: "Canonical" as const, feed_id: ref.id }] : [];
    }),
    refresh: `${list.current}:${list.running}:${list.requestedKey}`,
  });
  const podcastFor = (row: Row): FeedActionSubject | undefined => {
    const ref = parseResourceRef(row.item.ref);
    if ((ref?.scheme !== "podcast" && ref?.scheme !== "feed") || row.item.preview.body.kind !== "named" || row.item.missing) return undefined;
    const target = { kind: "Canonical" as const, feed_id: ref.id };
    return {
    target, feedKind: ref.scheme === "podcast" ? "podcast" : "article", title: row.item.label,
    facts: feedActionFacts(actionFacts, target,
      failure !== null ? { kind: "Failed", error: failure.error, retry: list.failure !== null ? list.retry : refreshResults, retrying: list.running !== null }
        : !list.fresh || list.running !== null ? { kind: "Resolving" } : null),
    };
  };
  const afterRemoval = (group: readonly Row[], index: number) => () => {
    for (let next = index + 1; next < group.length; next++) {
      const focus = root.current?.querySelector<HTMLElement>(`[data-resource-ref="${CSS.escape(group[next].item.ref)}"] [data-row-focusable]`);
      if (focus) return focus;
    }
    return findPaneLandmarkFocusTarget(paneId);
  };
  const repeatedCursor = selected.failure?.error.code === "E_REPEATED_CURSOR";
  const rejectedCursor = visit.cursorRejected || selected.failure?.error.code === "E_INVALID_CURSOR";
  useLayoutEffect(() => {
    if (selected.failure?.error.code === "E_INVALID_CURSOR" && !visit.cursorRejected) setVisit(current => ({ ...current, cursorRejected: true }));
  }, [selected.failure, visit.cursorRejected]);
  useEffect(() => {
    if (refreshError !== null && refreshError.failedStamp !== stamp && selected.current && selected.shownStale === stamp && selected.failure === null) setRefreshError(null);
  }, [refreshError, selected, stamp]);
  const staged = refreshPhase === "hybrid" ? hybridGeneration : refreshPhase === "lexical" ? lexicalGeneration : null;
  const refreshed = refreshPhase === "hybrid" ? hybrid : lexical;
  const candidate = staged !== null && refreshed.current && refreshed.shownKey === staged.key ? staged : hybridWanted && hybrid.current ? hybridGeneration : lexical.current ? lexicalGeneration : null;
  const candidateList = candidate?.phase === "hybrid" ? hybrid : lexical;
  const currentCandidate = candidate !== null && candidate.stamp === stamp && candidateList.shownKey === candidate.key;
  const held = currentCandidate && visit.adopted !== null && phaseRank[candidate.phase] > phaseRank[visit.adopted.phase];
  const adopt = useCallback((next: Generation, explicit: boolean) => {
    // A response captured before an invalidation is never authorized by a later click.
    if (live.current.key !== key || live.current.stamp !== next.stamp) return;
    setVisit(current => ({ ...current, adopted: next, selection: explicit ? null : current.selection, latched: explicit ? false : current.latched, cursorRejected: explicit ? false : current.cursorRejected }));
    if (explicit) {
      latched.current = false;
      const port = root.current?.closest<HTMLElement>("[data-pane-content]");
      if (port) writeScrollPosition(port, 0);
      window.getSelection()?.removeAllRanges();
      inputRef.current?.focus({ preventScroll: true });
    }
    setRefreshPhase(null);
    setRefreshError(null);
  }, [inputRef, key]);
  useLayoutEffect(() => {
    if (!enabled || candidate === null || !currentCandidate || motion !== "still") return;
    const replacingSame = staged?.key === candidate.key && visit.adopted?.phase === candidate.phase;
    if (staged?.key === candidate.key && (replacingSame || !latched.current)) {
      adopt(candidate, true);
    } else if (visit.adopted === null || (!returning.current && !latched.current && !visit.cursorRejected && phaseRank[candidate.phase] > phaseRank[visit.adopted.phase])) {
      adopt(candidate, false);
    }
  }, [adopt, candidate, currentCandidate, enabled, motion, staged, visit.adopted, visit.cursorRejected]);
  useEffect(() => {
    if (refreshPhase === null) return;
    const list = refreshPhase === "hybrid" ? hybrid : lexical;
    if (list.failure === null || list.running !== null) return;
    setRefreshError({ phase: refreshPhase, error: list.failure.error, shownStamp: list.shownStale ?? stamp, failedStamp: stamp });
    setRefreshPhase(null);
  }, [refreshPhase, lexical, hybrid, stamp]);

  const interact = useCallback(() => {
    latched.current = true;
    setVisit(current => current.latched ? current : { ...current, latched: true });
  }, []);
  const select = (event: SyntheticEvent) => {
    interact();
    if (!(event.target instanceof Element)) return;
    const ref = event.target.closest("[data-resource-ref]")?.getAttribute("data-resource-ref");
    const row = results.flatMap(row => [row, ...("matching_passage" in row && row.matching_passage ? [row.matching_passage] : [])]).find(row => row.item.ref === ref);
    if (row) setVisit(current => current.selection?.ref === row.item.ref ? current : { ...current, selection: { ref: row.item.ref, activation: row.item.activation } });
  };
  useEffect(() => {
    const port = root.current?.closest<HTMLElement>("[data-pane-content]");
    if (!port) return;
    const selection = () => {
      const selected = window.getSelection();
      if (selected !== null && !selected.isCollapsed && (root.current?.contains(selected.anchorNode) || root.current?.contains(selected.focusNode))) interact();
    };
    const pointer = (event: PointerEvent) => { if (event.target === port) interact(); };
    const keyboard = (event: KeyboardEvent) => { if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(event.key)) interact(); };
    document.addEventListener("selectionchange", selection);
    port.addEventListener("wheel", interact, { passive: true });
    port.addEventListener("touchmove", interact, { passive: true });
    port.addEventListener("pointerdown", pointer);
    port.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("selectionchange", selection);
      port.removeEventListener("wheel", interact);
      port.removeEventListener("touchmove", interact);
      port.removeEventListener("pointerdown", pointer);
      port.removeEventListener("keydown", keyboard);
    };
  }, [interact]);

  const retryPhase = (phase: SearchPhase) => {
    const attempt = visit.attempts[phase] + 1;
    const next = { phase, key: JSON.stringify([key, phase, stamp, attempt]), stamp };
    setVisit(current => ({ ...current, attempts: { ...current.attempts, [phase]: attempt } }));
    if (visit.adopted?.phase === phase) setRefreshPhase(next.phase);
    return next;
  };
  const refreshResults = () => {
    returning.current = false;
    if (!rejectedCursor && !prefixFailure && held && candidate !== null && candidate.stamp === live.current.stamp) { adopt(candidate, true); return; }
    const target = (rejectedCursor || prefixFailure) && visit.adopted !== null ? visit.adopted.phase : hybridWanted && visit.adopted?.phase !== "hybrid" ? "hybrid" : visit.adopted?.phase ?? "lexical";
    const next = retryPhase(target);
    if (visit.adopted?.phase !== target) {
      latched.current = false;
      setVisit(current => ({ ...current, latched: false }));
      setRefreshPhase(next.phase);
    }
  };
  const retrySearch = () => {
    returning.current = false;
    if (phaseIncidents.lexical !== null || refreshError?.phase === "lexical") retryPhase("lexical");
    if (hybridWanted && (phaseIncidents.hybrid !== null || refreshError?.phase === "hybrid")) retryPhase("hybrid");
  };
  const lexicalState = !enabled ? "idle" : lexical.current ? "ready" : lexical.failure !== null ? "failed" : "pending";
  const hybridState = !hybridWanted ? "idle" : hybrid.current ? "ready" : hybrid.failure !== null ? "failed" : "pending";
  const failure = selected.failure ?? (refreshError === null ? null : { op: "Refetch" as const, error: refreshError.error });
  const unfixable = [visit.adopted?.phase === "hybrid" ? undefined : lexical.failure?.error, hybrid.failure?.error, refreshError?.error].find(error => error !== undefined && UNFIXABLE.includes(error.code));
  const prefixFailure = visit.adopted !== null && failure !== null;
  const pending = enabled && visit.adopted?.phase !== "hybrid" && (lexicalState === "pending" || hybridState === "pending");
  const count = results.length + shownLocal.length;
  const canContinue = enabled && visit.adopted !== null && selected.current && !selected.complete
    && selected.failure === null && !rejectedCursor && refreshPhase === null;
  const forward = (port: HTMLElement) => {
    if (canContinue && nearDiscoveryTail(port, remoteTail.current)) { interact(); selected.fetchAhead(); }
    if (local.canContinue && nearDiscoveryTail(port, localTail.current)) local.fetchAhead();
  };
  usePaneForwardTravel(forward);
  useInitialDiscoveryDemand({ key, current: visit.adopted !== null && selected.current,
    active: !localApplies && canContinue && selected.active, viewport, run: selected.fetchAhead });
  const refreshValue = useMemo(() => [results, shownLocal], [results, shownLocal]);
  // Until this key adopts, the last key's rows stand, dimmed and inert.
  const [previous] = useState(() => shown.current?.accountId === accountId && shown.current.view === query.view ? shown.current.rows : []);
  // Text failed, unless related matches are still on their way: then it is a wait.
  const textFailed = visit.adopted === null && phaseIncidents.lexical !== null && !(hybridState === "pending" && phaseIncidents.hybrid === null);
  const stale = visit.adopted === null && pending && unfixable === undefined && !textFailed;
  const rows = stale ? previous : results;
  // Rows, or none where a fact stands instead: what the next key may stand dimmed.
  useLayoutEffect(() => {
    shown.current = { accountId, view: query.view, rows };
  });
  const filtered = query.requestedKinds !== null || query.formats.length + query.authors.length + query.roles.length > 0 || query.scope !== "all";
  const clearFilters: Verbs = [{ label: "clear filters", commandKey: "clear filters", run: () => commit({ ...emptySearchQuery(), text: query.text, view: query.view }) }];
  const noun = query.view === "passages" ? "passages" : "results";
  const readFeedback = useCollectionReadFeedback({ list: repeatedCursor || rejectedCursor ? { ...selected, failure: null } : selected, unit: query.view === "passages" ? { singular: "passage", plural: "passages" } : { singular: "result", plural: "results" }, waiting: false, outcome: null });
  const show = held && candidate !== null && !rejectedCursor && !prefixFailure ? () => { returning.current = false; adopt(candidate, true); } : null;
  usePaneReturnReady(blank || unsupported || visit.adopted !== null || unfixable !== undefined || (lexicalState === "failed" && hybridState !== "pending"));
  usePaneChrome({
    views: {
      label: "search view", value: query.view,
      items: VIEWS,
      onSelect: value => {
        if (value !== "resources" && value !== "passages") throw new Error("unknown search view");
        commit({ ...query, view: value });
      },
    },
    query: { kind: "Collation", collation },
    header: { kind: "Section", meta: count ? { kind: "Count", value: count, unit: query.view === "passages" ? "passage" : "result" } : { kind: "None" } },
  });
  const sections = GROUPS.map((group, index) => ({...group, rows: rows.filter(row => resourceGroup(row) === index)}));
  // Where results stand: the reason there are none, a wait, a failure, or the rows.
  const state = blank ? <Fact line={{ fact: query.view === "passages" ? "type text to find passages in your sources." : "type a name or text to search your nexus." }} />
    : unsupported ? query.view === "passages"
      ? <Fact line={{ fact: "none of these kinds have passages." }} verbs={[
        { label: "show resources", commandKey: "show resources", run: () => commit({ ...query, view: "resources" }) },
        { label: "any kind", commandKey: "any kind", run: () => commit({ ...query, requestedKinds: null }) },
      ]} />
      : <Fact line={{ fact: "these filters leave no kinds to search." }} verbs={[{ label: "any kind", commandKey: "any kind", run: () => commit({ ...query, requestedKinds: null }) }]} />
    : count > 0 ? null
    : unfixable !== undefined ? <Fact line={{ fact: unfixable.code === "E_INVALID_REQUEST" ? "nexus can’t run this search." : "the item this search is inside isn’t available." }} />
    : textFailed && phaseIncidents.lexical !== null
      ? <Failed error={phaseIncidents.lexical} noun={noun} retry={{ run: retrySearch, busy: lexical.running !== null || hybrid.running !== null }} />
    : visit.adopted === null ? stale && previous.length === 0 ? <Ruling /> : null
    : visit.adopted.phase === "lexical" && hybridState === "pending" ? <Ruling />
    : selected.complete && failure === null && (!hybridWanted || visit.adopted.phase === "hybrid" || hybrid.complete && hybrid.failure === null && hybrid.items.every(row => row.item.authored_by_viewer))
      && (!localApplies || local.scopeAvailable === true && local.complete && local.error === null)
      ? <Fact line={{ fact: query.view === "passages" ? "no passages match this search." : "no results match this search." }}
        verbs={filtered ? clearFilters : undefined} speak={active} />
      : null;
  return <PaneRefreshAnchor identity={visit.adopted?.key ?? key} value={refreshValue} ready={enabled && !stale}>
    <div ref={root} data-pane-return-scope="Search.Results" onPointerDownCapture={select} onFocusCapture={select} onKeyDownCapture={event => {
      interact();
      if (!event.shiftKey && ["Tab", "ArrowDown", "PageDown", "End"].includes(event.key)) {
        const port = viewport();
        if (port) forward(port);
      }
    }}>
    {localApplies ? <LocalResults local={local} rows={shownLocal} boundary={localTail} /> : null}
    {state}
    <div key={visit.adopted?.key ?? key} className={stale ? styles.stale : undefined} inert={stale || undefined}>
      {query.view === "resources" ? sections.filter(section => section.rows.length > 0).map(section => <section className={styles.section} key={section.key} aria-label={section.label}>
        <h2 className={styles.sectionHeading}>{section.label}</h2>
        <ResourceList ariaLabel={section.label}>
          {section.rows.map((row, index) => <SearchResult key={row.item.ref} row={row} selection={visit.selection} podcastSubject={stale ? undefined : podcastFor(row)} afterRemoval={afterRemoval(section.rows, index)} />)}
        </ResourceList>
      </section>) : rows.length > 0 ? <ResourceList ariaLabel="Passages">
        {rows.map((row, index) => <SearchResult key={row.item.ref} row={row} selection={visit.selection} podcastSubject={stale ? undefined : podcastFor(row)} afterRemoval={afterRemoval(rows, index)} />)}
      </ResourceList> : null}
    </div>
    {show !== null && motion === "still" ? <Fact line={{ fact: "results with related matches are ready." }}
      verbs={[{ label: "show", commandKey: "show related matches", run: show }]} /> : null}
    {visit.adopted?.phase === "lexical" && phaseIncidents.hybrid !== null && hybrid.failure?.op !== "More" && (unfixable === undefined || count > 0)
      ? <Failed error={phaseIncidents.hybrid} noun="related matches" retry={UNFIXABLE.includes(phaseIncidents.hybrid.code) ? undefined
        : { run: () => { returning.current = false; retryPhase("hybrid"); }, busy: hybrid.running !== null }} />
      : null}
    {repeatedCursor ? <Fact line={{ fact: `couldn’t load more ${noun}.`, reason: "the source repeated its continuation." }}
      verbs={[{ label: "refresh results", commandKey: "refresh results", run: refreshResults, busy: refreshPhase !== null }]} />
      : rejectedCursor ? <Fact line={{ fact: "the ranking has changed." }}
        verbs={[{ label: "refresh results", commandKey: "refresh results", run: refreshResults, busy: refreshPhase !== null }]} />
      : readFeedback.notice}
    {readFeedback.announcement}
    <DiscoveryTail boundary={remoteTail} label={`continue searching ${noun}`} action={canContinue ? () => { interact(); selected.more(); } : null}
      busy={selected.running !== null} show={results.length === 0 || selected.continuationNeedsAction} />
    </div>
  </PaneRefreshAnchor>;
}

/** Literal local matches: canonical label, exact excerpt, exact target. A retained source label
 * yields to the server's own row for the same ref; authored rows are only ever local. */
function LocalResults({ local, rows, boundary }: {
  local: ReturnType<typeof useLocalSearch>; rows: readonly LocalMatch[]; boundary: RefObject<HTMLDivElement | null>;
}) {
  const runtime = usePaneRuntime();
  if (local.scopeAvailable === false) return <Fact line={{ fact: "can’t search inside this item on this device." }} />;
  if (rows.length === 0 && !local.canContinue && local.error === null) return null;
  return <section className={styles.section} aria-label="on this device" data-pane-return-scope="Search.LocalResults">
    <h2 className={styles.sectionHeading}>on this device</h2>
    {rows.length > 0 ? <ResourceList ariaLabel="on this device">{rows.map(match => <LocalResult key={match.resource.ref} match={match} runtime={runtime} />)}</ResourceList> : null}
    {local.error instanceof AuthoredContinuationCursorError
      ? <Fact line={{ fact: "couldn’t load more results on this device.", reason: "the source repeated its continuation." }} />
      : <AuthoredReadFailure error={local.error} retry={local.retry} pending={local.pending} noun="search results" />}
    <DiscoveryTail boundary={boundary} label="continue searching on this device" action={local.canContinue && local.error === null ? local.more : null}
      busy={local.pending} show={rows.length === 0 || local.continuationNeedsAction} />
  </section>;
}

function LocalResult({ match, runtime }: { match: LocalMatch; runtime: ReturnType<typeof usePaneRuntime> }) {
  const { href, label, excerpt, resource } = match;
  const parsed = parseResourceRef(resource.ref);
  // justify-defect: local result identity is an authored canonical resource ref.
  if (parsed === null) throw new Error(`Invalid canonical local search ref: ${resource.ref}`);
  const type = resourceType(parsed.scheme, null);
  const typeLabel = resourceTypeName(type);
  const titleProvidesType = resource.kind === "highlight" && resource.excerpt?.kind === "content" && !excerptTextParts(resource.excerpt.body).exact.trim();
  const title = <ResourceIndexTitle type={type} hasArtwork={false}>
    {!href && !titleProvidesType ? <span className={`sr-only ${styles.accessibleContext}`} dir="ltr">{typeLabel}: </span> : null}
    {titleProvidesType ? typeLabel : label}
  </ResourceIndexTitle>;
  const activate = (event: Parameters<typeof activateTargetLink>[0]["event"]) => href ? activateTargetLink({ event, runtime, target: { href, labelHint: label } }) : undefined;
  return <li className={styles.localResult} data-resource-ref={resource.ref} data-collection-row-id={resource.ref}>
    {href ? <a className={styles.localTitle} dir="auto" href={href} aria-label={titleProvidesType ? typeLabel : `${typeLabel}: ${label}`}
      data-workspace-rich-target="true" data-row-focusable onClick={activate} onKeyDown={activate}>{title}</a>
      : <span className={styles.localTitle} dir="auto">{title}</span>}
    {parsed.scheme === "note_block" ? <span className={styles.localKind}> · {typeLabel}</span> : null}
    {resource.excerpt !== null ? <ResourceBody body={authoredItem(resource, match.readingRef, href).preview.body} /> : null}
    <ExcerptDisclosure item={authoredItem(resource, match.readingRef, href)} />
    {excerpt ? <p className={styles.evidence}>
      {match.matchedField === "annotation" ? <span>annotation: </span> : null}
      {excerpt.before ? "…" : null}
      {excerpt.marks.reduce<{ at: number; parts: ReactNode[] }>((acc, [start, end], index) => ({ at: end,
        parts: [...acc.parts, excerpt.text.slice(acc.at, start), <mark key={index}>{excerpt.text.slice(start, end)}</mark>] }), { at: 0, parts: [] }).parts}
      {excerpt.text.slice(excerpt.marks.at(-1)?.[1] ?? 0)}
      {excerpt.after ? "…" : null}
    </p> : null}
  </li>;
}

/** A matching passage owns the single evidence slot and its exact destination. */
function SearchResult({ row, selection, podcastSubject, afterRemoval }: { row: Row; selection: Selection | null; podcastSubject?: FeedActionSubject; afterRemoval?: () => HTMLElement | null }) {
  const runtime = usePaneRuntime();
  const evidence = ("matching_passage" in row ? row.matching_passage : null) ?? row;
  const { match } = evidence;
  const item = evidence.item.ref === selection?.ref ? { ...evidence.item, activation: selection.activation } : evidence.item;
  const body = item.preview.body;
  const hasExcerpt = (value: Schema<"ExcerptOut">) => Boolean(value.text || value.truncated_before || value.truncated_after);
  let excerpt: ReactNode = null;
  if (body.kind === "passage") excerpt = <><ResourceBody body={body} />{match && hasExcerpt(match.excerpt) ? <div><ExcerptText excerpt={match.excerpt} match={match} /></div> : null}</>;
  else if (match && hasExcerpt(match.excerpt)) excerpt = <ExcerptText excerpt={match.excerpt} match={match} />;
  else switch (body.kind) {
    case "prose": {
      const text = hasExcerpt(body.excerpt);
      excerpt = text || body.image_count > 0 ? <>{text ? <ExcerptText excerpt={body.excerpt} /> : null}{text && body.image_count > 0 ? " · " : null}{body.image_count > 0 ? body.image_count === 1 ? "image" : `${body.image_count} images` : null}</> : null;
      break;
    }
    case "images": excerpt = <>{body.count === 1 ? "image" : `${body.count} images`}{body.alts.map((alt, index) => alt && hasExcerpt(alt) ? <Fragment key={index}> · <ExcerptText excerpt={alt} /></Fragment> : null)}</>; break;
    case "reference": excerpt = body.label && hasExcerpt(body.label) ? <ExcerptText excerpt={body.label} /> : null; break;
    case "media": case "named": break;
    default: assertNever(body);
  }
  if (evidence.matched_field === "annotation" && excerpt) excerpt = <><span>annotation: </span>{excerpt}</>;
  const href = item.activation.href;
  const displayItem = row.item.ref === selection?.ref ? { ...row.item, activation: selection.activation } : row.item;
  return <ResourceIndexRow
    item={displayItem} podcastSubject={podcastSubject} afterRemoval={afterRemoval} occurrenceKey={`search:${row.item.ref}`} match={row.match} matchMethod={row.match_method}
    occurrenceLabel={evidence !== row ? ["matching passage", item.preview.source?.location_label].filter(Boolean).join(" · ") : undefined}
    presentation={{ kind: "Search", excerpt: <>
      {body.kind === "passage" ? <>
        {href ? <a href={href} data-resource-ref={item.ref} className={styles.evidence} data-workspace-rich-target="true"
          onClick={event => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}
          onKeyDown={event => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}>open matching passage</a> : null}
        {excerpt}
      </> : excerpt && href ? <a href={href} data-resource-ref={item.ref} className={styles.evidence} data-workspace-rich-target="true"
        onClick={event => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}
        onKeyDown={event => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}>{excerpt}</a> : excerpt}
      <ExcerptDisclosure item={item} />
    </> }}
  />;
}
