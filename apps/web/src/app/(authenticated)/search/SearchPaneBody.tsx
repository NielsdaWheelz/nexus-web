"use client";

import { useCallback, useMemo, useRef } from "react";
import LecternAddControl from "@/components/collections/LecternAddControl";
import ResourceBody from "@/components/resources/ResourceBody";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useChangeStamp } from "@/lib/api/changes";
import { apiTransportFeedback, type ApiError } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import type { ApiJson } from "@/lib/api/wire";
import { useMediaQueryRevision } from "@/lib/media/MediaSummaryProvider";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneIsVisible, usePaneRouter, usePaneRuntime, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { PASSAGE_KINDS, SEARCH_KINDS, disabledKinds } from "@/lib/search/kinds";
import { emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import { fetchSearchResultPage } from "@/lib/search/searchApi";
import { searchHref, searchQueryFromParams, searchQueryToParams } from "@/lib/search/searchParams";
import { cx } from "@/lib/ui/cx";
import { definePaneVisitDataKey, usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import SearchControls from "./SearchControls";
import styles from "./page.module.css";

type Response = ApiJson<"/search", "get">;
type Row = Response["results"][number];
type Metadata = Pick<Response, "view" | "semantic_status">;
const VISIT = definePaneVisitDataKey<ListSnapshot<Row, Metadata>>("Search.Results");
const UNFIXABLE = ["E_INVALID_REQUEST", "E_NOT_FOUND", "E_CONVERSATION_NOT_FOUND"];
const FAILED = {
  Load: "search couldn’t be completed",
  More: "more results couldn’t be loaded",
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
  const visible = usePaneIsVisible();
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
  const list = useServerList<Row, Metadata>({
    key: visible ? key : null,
    stale: `${useMediaQueryRevision()}:${useChangeStamp("Notes", "Metadata")}`,
    pageSize: 20,
    drain: false,
    active: true,
    visit: VISIT,
    id: (row) => row.item.ref,
    fetchPage: async (cursor, limit, signal) => {
      if (idle) return { items: [], next_cursor: null, metadata: { view: query.view, semantic_status: "not_requested" } };
      const page = await fetchSearchResultPage(query, { limit, cursor, signal });
      return {
        items: page.results,
        next_cursor: page.page.next_cursor,
        metadata: { view: page.view, semantic_status: page.semantic_status },
      };
    },
  });
  // Retained rows from a different query are useful only within the same view.
  const results = (idle && !list.current) || list.metadata?.view !== query.view ? [] : list.items;
  const commit = useCallback((next: SearchQuery) => router.replace(searchHref(next), {
    viewTransition: { kind: "collection-reflow" },
  }), [router]);
  const failure = list.failure;
  const searching = !idle && !list.current && failure === null;
  const count = results.length;
  const unit = query.view === "passages" ? count === 1 ? "passage" : "passages" : count === 1 ? "result" : "results";
  const status = blank
    ? "ready to search."
    : !list.current
      ? count > 0
        ? `${count} ${unit} retained from the previous search; ${failure ? "update failed" : "updating"}.`
        : failure ? "results unavailable." : "searching…"
      : failure?.op === "More"
        ? `${count} loaded ${unit}; loading more failed.`
        : `${count} loaded ${unit}${list.complete ? "." : "; more available."}`;
  usePaneReturnReady(list.current || failure !== null);
  usePaneChrome({
    query: {
      kind: "Controls", label: "Search content", focusInput,
      content: <SearchControls query={query} commit={commit} inputRef={inputRef} status={{ text: status, announce: list.current || failure === null }} />,
    },
    header: {
      kind: "Section",
      meta: searching ? { kind: "Pending" } : list.current && count > 0
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
  return <div data-pane-return-scope="Search.Results">
    {failure ? <FeedbackNotice
      content={failureContent(failure.error, failure.op)} announcement="Polite"
      actions={UNFIXABLE.includes(failure.error.code) ? undefined : failure.error.code === "E_EMBEDDING_PROVIDER_UNAVAILABLE"
        ? [{ label: "retry", onClick: list.retry, busy: list.running !== null }, { label: "restart search", onClick: () => { void list.refetch().catch(() => {}); }, busy: list.running !== null }]
        : [{ label: "retry", onClick: list.retry, busy: list.running !== null }]}
    /> : null}
    {searching ? <FeedbackNotice content={{ tone: "Info", title: "searching…" }} announcement="None" /> : null}
    {list.current && list.metadata?.semantic_status === "unavailable" ? <FeedbackNotice content={{ tone: "Warning", title: "related matches are unavailable; showing text matches" }} announcement="Polite" /> : null}
    {query.view === "resources" ? resourceSections.filter((section) => section.rows.length > 0).map((section) => <section className={styles.section} key={section.key} aria-label={section.label}>
      <h2 className={styles.sectionHeading}>{section.label}</h2>
      <ResourceOutlineList scope={`search:${key}:${section.key}`} ariaLabel={section.label} busy={searching}>
        {section.rows.map((row) => <SearchResult key={row.item.ref} row={row} />)}
      </ResourceOutlineList>
    </section>) : <ResourceOutlineList scope={`search:${key}`} ariaLabel="Passages" busy={searching}>
      {results.map((row) => <SearchResult key={row.item.ref} row={row} />)}
    </ResourceOutlineList>}
    {count === 0 && !failure ? blank && !unsupported ? <FeedbackNotice
      content={{ tone: "Info", title: query.view === "passages" ? "search inside your sources" : "search your nexus", message: query.view === "passages" ? "type text to find individual passages." : "type a name or text, or open filters to narrow by format or author." }} announcement="None"
    /> : list.current && list.complete ? <div className={styles.empty}>
      <FeedbackNotice content={{ tone: "Neutral", title: unsupported ? "no passages for these content types" : "no results found" }} announcement="None" />
      {unsupported ? <div className={styles.emptyActions}>
        <Button variant="secondary" size="md" onClick={() => commit({ ...query, view: "resources" })}>Show resources</Button>
        <Button variant="secondary" size="md" onClick={() => commit({ ...query, requestedKinds: null })}>Clear content types</Button>
      </div> : filtered ? <Button variant="secondary" size="md" onClick={() => commit({ ...emptySearchQuery(), text: query.text, view: query.view })}>Clear filters</Button> : null}
    </div> : null : null}
    <LoadMoreFooter hasMore={list.current && !list.complete} loading={list.running === "More"} disabled={list.running !== null} onLoadMore={list.more} label="Load more" />
  </div>;
}

function SearchResult({ row, parentOccurrenceKey }: { row: Row; parentOccurrenceKey?: string }) {
  const runtime = usePaneRuntime();
  const title = useRef<HTMLAnchorElement>(null);
  const { item } = row;
  const body = item.preview.body;
  const href = item.activation.href;
  const ref = parseResourceRef(item.ref);
  const readable = ref?.scheme === "media" && !item.missing && href !== null &&
    body.kind === "named" && body.media_kind !== null && ["web_article", "epub", "pdf"].includes(body.media_kind);
  const passage = "matching_passage" in row ? row.matching_passage : null;
  const child = parentOccurrenceKey !== undefined;
  const occurrenceKey = child ? `${parentOccurrenceKey}/matching:${item.ref}` : `search:${item.ref}`;
  return <ResourceOutlineRow incoming={null}
    item={item} occurrenceKey={occurrenceKey} match={row.match} matchMethod={row.match_method}
    occurrenceLabel={child ? "matching passage" : undefined}
    body={href && ref?.scheme !== "note_block" ? <a
      ref={title} className={cx(styles.resultTitle, body.kind === "named" && styles.resultName)} href={href} data-workspace-rich-target="true" data-row-focusable="true"
      aria-label={`${child ? "Open matching passage" : "Open"}: ${item.label}`}
      onClick={(event) => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}
      onKeyDown={(event) => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}
    ><ResourceBody body={body} match={row.match} /></a> : undefined}
    primaryControl={readable ? <LecternAddControl mediaId={ref.id} title={item.label} returnFocus={() => title.current} /> : undefined}
    resourceDetails={passage ? <div className={styles.matchingPassage}>
      <ResourceOutlineList scope={`${occurrenceKey}/matching`} ariaLabel="Matching passage">
        <SearchResult row={passage} parentOccurrenceKey={occurrenceKey} />
      </ResourceOutlineList>
    </div> : undefined}
  />;
}
