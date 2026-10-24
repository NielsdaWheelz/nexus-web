"use client";

import { Fragment, useCallback, useMemo, useRef, type ReactNode } from "react";
import { podcastActionFacts, type PodcastActionSubject } from "@/lib/actions/inlineActions";
import { usePodcastActionFacts } from "@/lib/podcasts/usePodcastActionFacts";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import ResourceList from "@/components/ui/ResourceList";
import ResourceIndexRow from "@/components/resources/ResourceIndexRow";
import { ExcerptText } from "@/components/resources/ResourceBody";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useChangeStamp } from "@/lib/api/changes";
import { apiTransportFeedback, type ApiError } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { assertNever } from "@/lib/assertNever";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { useMediaQueryRevision } from "@/lib/media/MediaSummaryProvider";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneIsActive, usePaneIsVisible, usePaneRouter, usePaneRuntime, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { PASSAGE_KINDS, SEARCH_KINDS, disabledKinds } from "@/lib/search/kinds";
import { emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import { fetchSearchResultPage } from "@/lib/search/searchApi";
import { searchHref, searchQueryFromParams, searchQueryToParams } from "@/lib/search/searchParams";
import { definePaneVisitDataKey, usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import SearchControls from "./SearchControls";
import styles from "./page.module.css";

type Response = ApiJson<"/search", "get">;
type Row = Response["results"][number];
type Metadata = Pick<Response, "semantic_status">;
const VISIT = definePaneVisitDataKey<ListSnapshot<Row, Metadata>>("Search.Results");
const UNFIXABLE = ["E_INVALID_REQUEST", "E_NOT_FOUND", "E_CONVERSATION_NOT_FOUND"];
const FAILED = {
  Load: "search couldn’t be completed",
  Refetch: "results couldn’t be refreshed",
};

function failureContent(error: ApiError, op: keyof typeof FAILED): FeedbackContent {
  const { requestId } = error;
  if (error.code === "E_INVALID_REQUEST")
    return { tone: "Danger", title: "this search isn’t valid", message: "adjust the query or filters and retry.", requestId };
  if (UNFIXABLE.includes(error.code))
    return { tone: "Danger", title: "the search scope is no longer available", requestId };
  if (error.code === "E_EMBEDDING_PROVIDER_UNAVAILABLE")
    return { tone: "Warning", title: FAILED[op], message: "related matches are unavailable. retry or restart this search.", requestId };
  const title = FAILED[op];
  return apiTransportFeedback(error, title) ?? { tone: "Danger", title, requestId };
}

export default function SearchPaneBody() {
  const params = usePaneSearchParams();
  const query = useMemo(() => searchQueryFromParams(params), [params]);
  return query === null ? <InvalidSearch /> : <SearchResults query={query} />;
}

function InvalidSearch() {
  const router = usePaneRouter();
  usePaneChrome({ header: { kind: "Section", meta: { kind: "None" } } });
  usePaneReturnReady(true);
  return <FeedbackNotice
    content={{ tone: "Danger", title: "this search isn’t valid", message: "the view, content types or formats in this address aren’t recognized." }}
    announcement="Polite"
    actions={[{ label: "reset search", onClick: () => router.replace("/search") }]}
  />;
}

/** The URL owns criteria; the server owns result identity, grouping and order. */
function SearchResults({ query }: { query: SearchQuery }) {
  const router = usePaneRouter();
  const paneId = usePaneRuntime()?.paneId;
  const root = useRef<HTMLDivElement>(null);
  const visible = usePaneIsVisible();
  const active = usePaneIsActive();
  const { inputRef, focusInput } = usePaneQueryInput();
  const blank = query.text.trim().length === 0 && (
    query.view === "passages" || query.formats.length + query.authors.length + query.roles.length === 0
  );
  const idle = blank;
  const filtered = query.requestedKinds !== null || query.formats.length + query.authors.length + query.roles.length > 0 || query.scope !== "all";
  const { kinds: disabled } = disabledKinds({
    hasFormatFilter: query.formats.length > 0,
    hasCreditFilter: query.authors.length + query.roles.length > 0,
  });
  const unsupported = query.view === "passages" && ![...(query.requestedKinds ?? SEARCH_KINDS)]
    .some((kind) => !disabled.has(kind) && PASSAGE_KINDS.has(kind));
  const key = searchQueryToParams(query).toString();
  const admitted = useRef<string | null>(null);
  if (visible) admitted.current = key;
  const list = useServerList<Row, Metadata>({
    key: admitted.current === key ? `/search?${key}` : null,
    stale: `${useMediaQueryRevision()}:${useChangeStamp("Notes", "NoteBodies", "Metadata")}`,
    pageSize: 20,
    active: active && !idle,
    visit: VISIT,
    id: (row) => row.item.ref,
    fetchPage: async (cursor, limit, signal) => {
      if (idle) return { items: [], next_cursor: null, metadata: { semantic_status: "not_requested" } };
      const page = await fetchSearchResultPage(query, { limit, cursor, signal });
      return {
        items: page.results,
        next_cursor: page.page.next_cursor,
        metadata: { semantic_status: page.semantic_status },
      };
    },
  });
  const results = list.items;
  const actionFacts = usePodcastActionFacts({ scope: `Search:${key}`,
    targets: results.flatMap(row => row.item.ref.startsWith("podcast:") ? [{ kind: "Canonical" as const, podcast_id: row.item.ref.slice(8) }] : []),
    refresh: `${list.current}:${list.running}:${list.requestedKey}`,
  });
  const factsError = actionFacts.status === "loading" ? null : actionFacts.error;
  const podcastFor = (row: Row): PodcastActionSubject | undefined => row.item.ref.startsWith("podcast:") ? {
    target: { kind: "Canonical", podcast_id: row.item.ref.slice(8) }, title: row.item.label,
    facts: list.failure !== null ? { kind: "Failed", error: list.failure.error, retry: list.retry, retrying: list.running !== null }
      : !list.fresh || list.running !== null ? { kind: "Resolving" } : podcastActionFacts(actionFacts, { kind: "Canonical", podcast_id: row.item.ref.slice(8) }),
  } : undefined;
  const afterRemoval = (following: readonly Row[]) => () => following.map(row =>
    root.current?.querySelector<HTMLElement>(`[data-resource-ref="${CSS.escape(row.item.ref)}"] [data-row-focusable]`)).find(element => element !== null && element !== undefined)
    ?? findPaneLandmarkFocusTarget(paneId);
  const commit = useCallback((next: SearchQuery) => router.replace(searchHref(next)), [router]);
  const failure = list.failure?.op === "More" ? null : list.failure;
  const searching = !idle && !list.current && failure === null;
  const count = results.length;
  const emptyTitle = list.complete
    ? unsupported ? "no passages for these content types" : "no results found"
    : "no results found so far.";
  const feedback = useCollectionReadFeedback({
    list,
    unit: query.view === "passages" ? { singular: "passage", plural: "passages" } : { singular: "result", plural: "results" },
    waiting: searching,
    outcome: idle ? null : count > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
  const status = blank ? "ready to search." : searching ? "searching…" : "";
  usePaneReturnReady(list.current || failure !== null);
  usePaneChrome({
    query: {
      kind: "Controls", label: "Search content", focusInput,
      content: <SearchControls query={query} commit={commit} inputRef={inputRef} status={{ text: status, announce: searching && active }} />,
    },
    header: {
      kind: "Section",
      meta: searching ? { kind: "Pending" } : list.complete && count > 0
        ? { kind: "Count", value: count, unit: query.view === "passages" ? "passage" : "result" }
        : { kind: "None" },
    },
  });

  const resourceSections = [
    { key: "exact", label: "exact matches", rows: results.filter((row) => "section" in row && row.section === "primary" && row.name_match === "exact") },
    { key: "primary", label: "resources", rows: results.filter((row) => "section" in row && row.section === "primary" && row.name_match !== "exact") },
    { key: "saved", label: "saved passages", rows: results.filter((row) => "section" in row && row.section === "saved") },
    { key: "inside", label: "inside sources", rows: results.filter((row) => "section" in row && row.section === "inside") },
  ];
  return <div ref={root} data-pane-return-scope="Search.Results">
    {failure && failure.op !== "More" ? <FeedbackNotice
      content={failureContent(failure.error, failure.op)} announcement="Polite"
      actions={UNFIXABLE.includes(failure.error.code) ? undefined : failure.error.code === "E_EMBEDDING_PROVIDER_UNAVAILABLE"
        ? [{ label: "retry", onClick: list.retry, busy: list.running !== null }, { label: "restart search", onClick: () => { void list.refetch().catch(() => {}); }, busy: list.running !== null }]
        : [{ label: "retry", onClick: list.retry, busy: list.running !== null }]}
    /> : null}
    {factsError !== null ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t check podcast subscriptions", requestId: factsError.requestId }} announcement="Polite"
      actions={[{ label: "retry checking subscription", onClick: actionFacts.refetch, busy: actionFacts.status === "failed" ? actionFacts.retrying : actionFacts.status === "ready" && actionFacts.refreshing }]} /> : null}
    {searching ? <FeedbackNotice content={{ tone: "Info", title: "searching…" }} announcement="None" /> : null}
    {list.current && list.metadata?.semantic_status === "unavailable" ? <FeedbackNotice content={{ tone: "Warning", title: "related matches are unavailable; showing text matches" }} announcement="Polite" /> : null}
    {query.view === "resources" ? resourceSections.filter((section) => section.rows.length > 0).map((section) => <section className={styles.section} key={section.key} aria-label={section.label}>
      <h2 className={styles.sectionHeading}>{section.label}</h2>
      <ResourceList ariaLabel={section.label} busy={searching}>
        {section.rows.map((row, index) => <SearchResult key={row.item.ref} row={row} podcastSubject={podcastFor(row)} afterRemoval={afterRemoval(section.rows.slice(index + 1))} />)}
      </ResourceList>
    </section>) : <ResourceList ariaLabel="Passages" busy={searching}>
      {results.map((row, index) => <SearchResult key={row.item.ref} row={row} podcastSubject={podcastFor(row)} afterRemoval={afterRemoval(results.slice(index + 1))} />)}
    </ResourceList>}
    {count === 0 && !failure ? blank && !unsupported ? <FeedbackNotice
      content={{ tone: "Info", title: query.view === "passages" ? "search inside your sources" : "search your nexus", message: query.view === "passages" ? "type text to find individual passages." : "type a name or text, or open filters to narrow by format or author." }} announcement="None"
    /> : list.current ? <div className={styles.empty}>
      <FeedbackNotice content={{ tone: "Neutral", title: emptyTitle }} announcement="None" />
      {list.complete && unsupported ? <div className={styles.emptyActions}>
        <Button onClick={() => commit({ ...query, view: "resources" })}>Show resources</Button>
        <Button onClick={() => commit({ ...query, requestedKinds: null })}>Clear content types</Button>
      </div> : filtered ? <Button onClick={() => commit({ ...emptySearchQuery(), text: query.text, view: query.view })}>Clear filters</Button> : null}
    </div> : null : null}
    {feedback.notice}
    {feedback.announcement}
  </div>;
}

/** A matching passage owns the single evidence slot and its exact destination. */
function SearchResult({ row, podcastSubject, afterRemoval }: { row: Row; podcastSubject?: PodcastActionSubject; afterRemoval?: () => HTMLElement | null }) {
  const runtime = usePaneRuntime();
  const evidence = ("matching_passage" in row ? row.matching_passage : null) ?? row;
  const { item, match } = evidence;
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
  return <ResourceIndexRow
    item={row.item} podcastSubject={podcastSubject} afterRemoval={afterRemoval} occurrenceKey={`search:${row.item.ref}`} match={row.match} matchMethod={row.match_method}
    occurrenceLabel={evidence !== row ? ["matching passage", item.preview.source?.location_label].filter(Boolean).join(" · ") : undefined}
    presentation={{ kind: "Search", excerpt: excerpt && href ? <a href={href}
      className={styles.evidence} data-workspace-rich-target="true"
      onClick={event => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}
      onKeyDown={event => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}
    >{excerpt}</a> : excerpt }}
  />;
}
