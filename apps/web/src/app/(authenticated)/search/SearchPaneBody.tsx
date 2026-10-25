"use client";

// Two complete server-ranked lists. Hidden generations own page one; adoption
// freezes their key/stamp, then ordinary invalidation rereads the selected prefix.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { podcastActionFacts, type PodcastActionSubject } from "@/lib/actions/inlineActions";
import { usePodcastActionFacts } from "@/lib/podcasts/usePodcastActionFacts";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import ResourceList from "@/components/ui/ResourceList";
import ResourceIndexRow from "@/components/resources/ResourceIndexRow";
import { ExcerptText } from "@/components/resources/ResourceBody";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { assertNever } from "@/lib/assertNever";
import { useChangeStamp } from "@/lib/api/changes";
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
import { SEARCH_READ_TIMEOUT_MS } from "@/lib/search/policy";
import { SEARCH_ACTION_LABELS, searchProgress } from "@/lib/search/progress";
import { definePaneVisitDataKey, usePaneReturnReady, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import SearchControls from "./SearchControls";
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
const UNFIXABLE = ["E_INVALID_REQUEST", "E_NOT_FOUND", "E_CONVERSATION_NOT_FOUND"];
const PROGRESS_REVEAL_MS = 150;
const phaseRank = { lexical: 0, hybrid: 1 };

export default function SearchPaneBody() {
  const params = usePaneSearchParams();
  const { accountId } = useAuthenticatedAccount();
  const query = useMemo(() => searchQueryFromParams(params), [params]);
  return query === null ? <InvalidSearch /> : <SearchResults key={`${accountId}:${searchQueryToParams(query)}`} query={query} accountId={accountId} />;
}

function InvalidSearch() {
  const router = usePaneRouter();
  usePaneChrome({ header: { kind: "Section", meta: { kind: "None" } } });
  usePaneReturnReady(true);
  return <FeedbackNotice content={{ tone: "Danger", title: "this search isn’t valid", message: "the view, content types or formats in this address aren’t recognized." }} announcement="Polite" actions={[{ label: "reset search", onClick: () => router.replace("/search") }]} />;
}

function SearchResults({ query, accountId }: { query: SearchQuery; accountId: string }) {
  const router = usePaneRouter();
  const paneId = usePaneRuntime()?.paneId;
  const visible = usePaneIsVisible();
  const active = usePaneIsActive();
  const { inputRef, focusInput } = usePaneQueryInput();
  const root = useRef<HTMLDivElement>(null);
  const key = searchQueryToParams(query).toString();
  const stamp = `${useMediaQueryRevision()}:${useChangeStamp("Notes", "NoteBodies", "Metadata")}`;
  const captured = useRef<SearchVisit | null>(null);
  const restored = usePaneVisitData(VISIT, useCallback(() => captured.current, []));
  const [visit, setVisit] = useState<SearchVisit>(() => restored?.accountId === accountId ? restored : {
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
    pageSize: 20, drain: false, retainPreviousKey: true, active: active && enabled, visit: LEXICAL_VISIT,
    retry: "manual", timeoutMs: SEARCH_READ_TIMEOUT_MS.lexical,
    id: row => row.item.ref,
    fetchPage: async (cursor, limit, signal) => {
      const page = await fetchSearchResultPage(query, { phase: "lexical", limit, cursor, signal });
      return { items: page.results, next_cursor: page.page.next_cursor, metadata: { view: page.view, phase: page.phase, semantic_status: page.semantic_status } };
    },
  });
  const hybrid = useServerList<Row, Metadata>({
    key: hybridWanted ? hybridGeneration.key : null,
    stale: visit.adopted?.key === hybridGeneration.key ? selectedStamp("hybrid") : hybridGeneration.stamp,
    pageSize: 20, drain: false, retainPreviousKey: true, active: active && hybridWanted, visit: HYBRID_VISIT,
    retry: "manual", timeoutMs: SEARCH_READ_TIMEOUT_MS.hybrid,
    id: row => row.item.ref,
    fetchPage: async (cursor, limit, signal) => {
      const page = await fetchSearchResultPage(query, { phase: "hybrid", limit, cursor, signal });
      return { items: page.results, next_cursor: page.page.next_cursor, metadata: { view: page.view, phase: page.phase, semantic_status: page.semantic_status } };
    },
  });
  const selected = visit.adopted?.phase === "hybrid" ? hybrid : lexical;
  const results = visit.adopted === null ? [] : selected.items;
  const list = selected;
  const actionFacts = usePodcastActionFacts({ scope: `Search:${key}`,
    targets: results.flatMap(row => row.item.ref.startsWith("podcast:") && row.item.preview.body.kind === "named" && !row.item.missing ? [{ kind: "Canonical" as const, podcast_id: row.item.ref.slice(8) }] : []),
    refresh: `${list.current}:${list.running}:${list.requestedKey}`,
  });
  const factsError = actionFacts.status === "loading" ? null : actionFacts.error;
  const podcastFor = (row: Row): PodcastActionSubject | undefined => row.item.ref.startsWith("podcast:") && row.item.preview.body.kind === "named" && !row.item.missing ? {
    target: { kind: "Canonical", podcast_id: row.item.ref.slice(8) }, title: row.item.label,
    facts: podcastActionFacts(actionFacts, { kind: "Canonical", podcast_id: row.item.ref.slice(8) },
      failure !== null ? { kind: "Failed", error: failure.error, retry: list.failure !== null ? list.retry : refreshResults, retrying: list.running !== null }
        : !list.fresh || list.running !== null ? { kind: "Resolving" } : null),
  } : undefined;
  const afterRemoval = (following: readonly Row[]) => () => following.map(row =>
    root.current?.querySelector<HTMLElement>(`[data-resource-ref="${CSS.escape(row.item.ref)}"] [data-row-focusable]`)).find(element => element !== null && element !== undefined)
    ?? findPaneLandmarkFocusTarget(paneId);
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
      if (port) port.scrollTop = 0;
      window.getSelection()?.removeAllRanges();
      focusInput();
    }
    setRefreshPhase(null);
    setRefreshError(null);
  }, [focusInput, key]);
  useLayoutEffect(() => {
    if (!enabled || candidate === null || !currentCandidate) return;
    const replacingSame = staged?.key === candidate.key && visit.adopted?.phase === candidate.phase;
    if (staged?.key === candidate.key && (replacingSame || !latched.current)) {
      adopt(candidate, true);
    } else if (visit.adopted === null || (!returning.current && !latched.current && !visit.cursorRejected && phaseRank[candidate.phase] > phaseRank[visit.adopted.phase])) {
      adopt(candidate, false);
    }
  }, [adopt, candidate, currentCandidate, enabled, staged, visit.adopted, visit.cursorRejected]);
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
    setRefreshError(null);
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
    if (lexical.failure !== null || refreshError?.phase === "lexical") retryPhase("lexical");
    if (hybridWanted && (hybrid.failure !== null || refreshError?.phase === "hybrid")) retryPhase("hybrid");
  };
  const lexicalState = !enabled ? "idle" : lexical.current ? "ready" : lexical.failure !== null ? "failed" : "pending";
  const hybridState = !hybridWanted ? "idle" : hybrid.current ? "ready" : hybrid.failure !== null ? "failed" : "pending";
  const progress = searchProgress({ phase: visit.adopted?.phase ?? null, count: results.length, lexical: lexicalState, hybrid: hybridState, held });
  const failure = selected.failure ?? (refreshError === null ? null : { op: "Refetch" as const, error: refreshError.error });
  const unfixable = [visit.adopted?.phase === "hybrid" ? undefined : lexical.failure?.error, hybrid.failure?.error, refreshError?.error].find(error => error !== undefined && UNFIXABLE.includes(error.code));
  const prefixFailure = visit.adopted !== null && failure !== null;
  const pending = enabled && visit.adopted?.phase !== "hybrid" && (lexicalState === "pending" || hybridState === "pending");
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!pending) { setRevealed(false); return; }
    const timer = setTimeout(() => setRevealed(true), PROGRESS_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  const message = unfixable !== undefined ? unfixable.code === "E_INVALID_REQUEST" ? "this search isn’t valid" : "the search scope is no longer available"
    : rejectedCursor ? "results need refreshing." : prefixFailure ? failure.op === "More" ? "more results couldn’t be loaded. your results are still here." : "results couldn’t be refreshed. your results are still here."
    : blank ? "ready to search." : unsupported ? query.view === "passages" ? "no passages for these content types" : "no results found." : !pending || revealed || progress.action !== null ? progress.text : "";
  const action = rejectedCursor ? "refresh" : prefixFailure ? failure.op !== "More" ? "refresh" : null : progress.action;
  const count = results.length;
  const unit = query.view === "passages" ? count === 1 ? "passage" : "passages" : count === 1 ? "result" : "results";
  const statusAction = unfixable !== undefined || prefixFailure && failure.op === "More" ? undefined
    : action === null ? undefined : { label: SEARCH_ACTION_LABELS[action], onClick: action === "refresh" ? refreshResults : action === "related" ? () => { returning.current = false; retryPhase("hybrid"); } : retrySearch, busy: refreshPhase !== null };
  const readFeedback = useCollectionReadFeedback({
    list: rejectedCursor ? { ...selected, retry: refreshResults } : selected,
    unit: query.view === "passages" ? { singular: "passage", plural: "passages" } : { singular: "result", plural: "results" },
    waiting: false, outcome: null, returnFocus: () => inputRef.current,
  });
  const commit = useCallback((next: SearchQuery) => router.replace(searchHref(next)), [router]);
  usePaneReturnReady(blank || unsupported || visit.adopted !== null || unfixable !== undefined || (lexicalState === "failed" && hybridState !== "pending"));
  usePaneChrome({
    query: { kind: "Controls", label: "Search content", focusInput, content: <SearchControls query={query} commit={commit} inputRef={inputRef} status={{ text: message || "\u00a0", detail: count ? `${count} loaded ${unit}.` : undefined, announce: true, action: statusAction }} /> },
    header: { kind: "Section", meta: count ? { kind: "Count", value: count, unit: query.view === "passages" ? "passage" : "result" } : pending ? { kind: "Pending" } : { kind: "None" } },
  });
  const sections = [
    { key: "exact", label: "exact matches", rows: results.filter(row => "section" in row && row.section === "primary" && row.name_match === "exact") },
    { key: "primary", label: "resources", rows: results.filter(row => "section" in row && row.section === "primary" && row.name_match !== "exact") },
    { key: "saved", label: "saved passages", rows: results.filter(row => "section" in row && row.section === "saved") },
    { key: "inside", label: "inside sources", rows: results.filter(row => "section" in row && row.section === "inside") },
  ];
  return <div ref={root} data-pane-return-scope="Search.Results" onPointerDownCapture={select} onFocusCapture={select} onKeyDownCapture={interact}>
    <div key={visit.adopted?.key ?? key}>
      {query.view === "resources" ? sections.filter(section => section.rows.length > 0).map(section => <section className={styles.section} key={section.key} aria-label={section.label}>
        <h2 className={styles.sectionHeading}>{section.label}</h2>
        <ResourceList ariaLabel={section.label} busy={pending}>
          {section.rows.map((row, index) => <SearchResult key={row.item.ref} row={row} selection={visit.selection} podcastSubject={podcastFor(row)} afterRemoval={afterRemoval(section.rows.slice(index + 1))} />)}
        </ResourceList>
      </section>) : <ResourceList ariaLabel="Passages" busy={pending}>
        {results.map((row, index) => <SearchResult key={row.item.ref} row={row} selection={visit.selection} podcastSubject={podcastFor(row)} afterRemoval={afterRemoval(results.slice(index + 1))} />)}
      </ResourceList>}
    </div>
    {factsError !== null ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t check podcast subscriptions", requestId: factsError.requestId }} announcement="Polite"
      actions={[{ label: "retry checking subscription", onClick: actionFacts.refetch, busy: actionFacts.status === "failed" ? actionFacts.retrying : actionFacts.status === "ready" && actionFacts.refreshing }]} /> : null}
    {blank ? <FeedbackNotice content={{ tone: "Info", title: query.view === "passages" ? "search inside your sources" : "search your nexus", message: query.view === "passages" ? "type text to find individual passages." : "type a name or text, or open filters to narrow by format or author." }} announcement="None" /> : null}
    {unsupported && query.view === "passages" ? <div className={styles.empty}><FeedbackNotice content={{ tone: "Neutral", title: message }} announcement="None" /><div className={styles.emptyActions}>
      <Button onClick={() => commit({ ...query, view: "resources" })}>show resources</Button>
      <Button onClick={() => commit({ ...query, requestedKinds: null })}>clear content types</Button>
    </div></div> : count === 0 && !pending && !blank && (query.requestedKinds !== null || query.formats.length + query.authors.length + query.roles.length > 0 || query.scope !== "all") ? <Button onClick={() => commit({ ...emptySearchQuery(), text: query.text, view: query.view })}>clear filters</Button> : null}
    {readFeedback.notice}
    {readFeedback.announcement}
    {visit.adopted !== null && selected.current && !selected.complete && selected.failure === null && !rejectedCursor
      ? <Button disabled={refreshPhase !== null || selected.running !== null} aria-busy={selected.running === "More" || undefined}
        onClick={() => { interact(); selected.more(); }}>load more</Button> : null}
  </div>;
}

/** A matching passage owns the single evidence slot and its exact destination. */
function SearchResult({ row, selection, podcastSubject, afterRemoval }: { row: Row; selection: Selection | null; podcastSubject?: PodcastActionSubject; afterRemoval?: () => HTMLElement | null }) {
  const runtime = usePaneRuntime();
  const evidence = ("matching_passage" in row ? row.matching_passage : null) ?? row;
  const { match } = evidence;
  const item = evidence.item.ref === selection?.ref ? { ...evidence.item, activation: selection.activation } : evidence.item;
  const body = item.preview.body;
  const hasExcerpt = (value: Schema<"ExcerptOut">) => Boolean(value.text || value.truncated_before || value.truncated_after);
  let excerpt: ReactNode = null;
  if (match && hasExcerpt(match.excerpt)) excerpt = <ExcerptText excerpt={match.excerpt} match={match} />;
  else switch (body.kind) {
    case "passage": excerpt = hasExcerpt(body.exact) ? <ExcerptText excerpt={body.exact} /> : null; break;
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
  const href = item.activation.href;
  const displayItem = row.item.ref === selection?.ref ? { ...row.item, activation: selection.activation } : row.item;
  return <ResourceIndexRow
    item={displayItem} podcastSubject={podcastSubject} afterRemoval={afterRemoval} occurrenceKey={`search:${row.item.ref}`} match={row.match} matchMethod={row.match_method}
    occurrenceLabel={evidence !== row ? ["matching passage", item.preview.source?.location_label].filter(Boolean).join(" · ") : undefined}
    presentation={{ kind: "Search", excerpt: excerpt && href ? <a href={href} data-resource-ref={item.ref}
      className={styles.evidence} data-workspace-rich-target="true"
      onClick={event => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}
      onKeyDown={event => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}
    >{excerpt}</a> : excerpt }}
  />;
}
