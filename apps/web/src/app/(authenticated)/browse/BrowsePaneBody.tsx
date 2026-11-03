"use client";

// Browse fans a query out to independent source sections. Each shared list owns traversal,
// errors and its pane-visit snapshot, and reports its cold read to the body. The body owns one
// rule: once every section has failed with one transport, it says so once, and the sections stay
// mounted, quiet and hidden, because each owns the read that can recover. While that sentence may
// still come, a failed section waits quiet in its ruling. Rereading cold sections stand in a ruling.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { podcastActionFacts } from "@/lib/actions/inlineActions";
import { usePodcastActionFacts } from "@/lib/podcasts/usePodcastActionFacts";
import CollectionView from "@/components/collections/CollectionView";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import RadioGroup from "@/components/ui/RadioGroup";
import PaneSurface from "@/components/ui/PaneSurface";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import type { ApiError } from "@/lib/api/client";
import { transportOf } from "@/lib/api/failure";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { fetchBrowsePage, type BrowseCandidate, type BrowseKind } from "@/lib/browse/api";
import {
  BROWSE_KIND_LABELS,
  BROWSE_KINDS,
  BROWSE_SOURCE_LABELS,
  browseDraftInvalid,
  browseHref,
  browseSections,
  browseSourcesFor,
  browseSupportsNewest,
  readBrowseQuery,
  withBrowseFilters,
  type BrowseQuery,
  type BrowseSection,
} from "@/lib/browse/query";
import { presentBrowseCandidate } from "@/lib/collections/presenters/browse";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { usePaneIsActive, usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import { providerRefusal } from "./providerRefusal";
import styles from "./browse.module.css";

/** A section's cold read, as far as the body's rule needs it. */
interface SectionStatus {
  readonly settled: boolean;
  /** A failed cold read the transport speaks for: neither the provider's refusal nor a refused query. */
  readonly failure: ApiError | null;
  /** The server refused the query itself; the body replaces the pane. */
  readonly invalid: boolean;
  readonly running: boolean;
  /** Stable, so a report changes only with the read. */
  readonly refetch: () => Promise<void>;
}
const keyOf = (section: BrowseSection) => `${section.kind}:${section.source}`;
const KIND_NOUNS: Readonly<Record<BrowseKind, string>> = {
  Pdf: "pdfs", Epub: "epubs", WebArticle: "web articles", Video: "videos", Podcast: "podcasts",
};
const refusedQuery = (error: ApiError) => error.code === "E_INVALID_REQUEST" || error.code === "E_INVALID_BROWSE_QUERY";

/** Browse owns submitted text, exclusive kind/source choices and provider order. */
function BrowseToolbar({ query, inputRef, onQuery }: {
  readonly query: BrowseQuery;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onQuery: (query: BrowseQuery | null) => void;
}) {
  const statusId = useId();
  const [draft, setDraft] = useState(query.text);
  const [committed, setCommitted] = useState(query.text);
  if (committed !== query.text) {
    setCommitted(query.text);
    setDraft(query.text);
  }
  const normalized = draft.trim().normalize("NFC");
  const invalid = browseDraftInvalid(normalized);
  const sources = browseSourcesFor(query.kind);
  const youTube = browseSupportsNewest(query);
  const mixedSources = youTube && browseSections(query).length > 1;
  const chips = [
    ...(query.kind === "All" ? [] : [{ id: "kind", label: `Kind: ${BROWSE_KIND_LABELS[query.kind]}` }]),
    ...(query.source === null ? [] : [{ id: "source", label: `Source: ${BROWSE_SOURCE_LABELS[query.source]}` }]),
  ];
  return <PaneQueryToolbar
    inputRef={inputRef}
    input={{
      label: "Search across sources",
      placeholder: "Search across sources",
      value: draft,
      appliedValue: query.text,
      error: invalid ? "search text is over 200 characters or has control characters." : undefined,
      onChange: setDraft,
      onClear: () => { setDraft(""); onQuery({ ...query, text: "" }); },
    }}
    submit={{ onSubmit: () => {
      if (invalid) { inputRef.current?.focus({ preventScroll: true }); return; }
      setDraft(normalized);
      onQuery({ ...query, text: normalized });
    } }}
    options={{
      label: "Filters",
      activeCount: chips.length,
      onClear: () => onQuery(withBrowseFilters(query, { kind: "All", source: null })),
      content: <>
        <RadioGroup
          label="Kind"
          value={query.kind}
          choices={[{ value: "All", label: "All kinds" }, ...BROWSE_KINDS.map((value) => ({ value, label: BROWSE_KIND_LABELS[value] }))]}
          onChange={(value) => onQuery(withBrowseFilters(query, { kind: BROWSE_KINDS.find((kind) => kind === value) ?? "All", source: null }))}
        />
        {sources.length > 1 || query.source !== null ? <RadioGroup
          label="Source"
          value={query.source ?? ""}
          choices={[{ value: "", label: "All sources" }, ...sources.map((value) => ({ value, label: BROWSE_SOURCE_LABELS[value] }))]}
          onChange={(value) => onQuery(withBrowseFilters(query, { kind: query.kind, source: sources.find((source) => source === value) ?? null }))}
        /> : null}
      </>,
    }}
    sort={youTube ? {
      label: "YouTube sort", value: query.sort,
      choices: [{ value: "Relevance", label: "Relevance" }, { value: "Newest", label: "Newest source publication" }],
      onChange: (value) => onQuery({ ...query, sort: value === "Newest" ? "Newest" : "Relevance" }),
    } : undefined}
    chips={{ items: chips, onRemove: (id) => onQuery(withBrowseFilters(query, {
      kind: id === "kind" ? "All" : query.kind,
      source: null,
    })) }}
    status={{ placement: "Details", id: statusId, visible: mixedSources || !youTube || query.text === "", content: <>
      {mixedSources ? <span>Other sources: relevance</span> : null}
      {!youTube ? <span>Order: relevance</span> : null}
      <span id={statusId}>{query.text ? "" : "Enter a search term to browse sources."}</span>
    </> }}
    onReset={draft || browseHref(query) !== "/browse" ? () => { setDraft(""); onQuery(null); } : undefined}
  />;
}

/** Each kind/source keeps its own visit snapshot and its own failure. `quiet` while the body may
 * yet speak, or speaks, for every section at once. */
function BrowseSourceSection({ queryKey, text, section, quiet, onStatus }: {
  readonly queryKey: string;
  readonly text: string;
  readonly section: BrowseSection;
  readonly quiet: boolean;
  readonly onStatus: (key: string, status: SectionStatus) => void;
}) {
  const active = usePaneIsActive();
  const display = useRenderEnvironment();
  const headingId = useId();
  const sectionRef = useRef<HTMLElement | null>(null);
  const sectionKey = keyOf(section);
  const visit = useMemo(
    () => definePaneVisitDataKey<ListSnapshot<BrowseCandidate>>(`Browse.Section.${sectionKey}`),
    [sectionKey],
  );
  const readKey = JSON.stringify(["browse", text, section.kind, section.source, section.sort]);
  const list = useServerList<BrowseCandidate>({
    key: readKey,
    visit,
    stale: "",
    pageSize: 20,
    active,
    id: (item) => item.kind === "OwnedMedia" ? item.resolution.action_ref : item.target,
    fetchPage: (cursor, limit, signal) => fetchBrowsePage({ q: text, ...section, cursor, limit, signal }),
  });
  // A failure over shown rows heals unseen; continuation is the read feedback's.
  const running = list.running !== null;
  const cold = list.current || running ? null : list.failure?.error ?? null;
  const refusal = cold === null ? null : providerRefusal(cold, display);
  const invalid = cold !== null && refusedQuery(cold);
  const failure = refusal !== null || invalid ? null : cold;
  const settled = list.current || cold !== null;
  const { refetch } = list;
  useEffect(() => {
    onStatus(sectionKey, { settled, failure, invalid, running, refetch });
  }, [queryKey, onStatus, sectionKey, settled, failure, invalid, running, refetch]);
  const summaries = useMediaSummaries(list.items.flatMap((item) =>
    item.resolution.kind === "InNexusMedia" ? [item.resolution.media_summary] : [],
  ));
  const actionFacts = usePodcastActionFacts({ scope: `Browse.${sectionKey}:${queryKey}`,
    targets: list.items.flatMap(item => item.kind === "Podcast" ? [{ kind: "Discovery" as const, target: item.target }] : []),
    refresh: `${list.current}:${list.running}:${list.requestedKey}`,
  });
  const rows = list.items.flatMap((item) => {
    if (item.resolution.kind !== "InNexusMedia") {
      return [presentBrowseCandidate(item, item.kind === "Podcast" ? {
        target: { kind: "Discovery", target: item.target }, title: item.title,
        facts: podcastActionFacts(actionFacts, { kind: "Discovery", target: item.target },
          list.failure !== null ? { kind: "Failed", error: list.failure.error, retry: list.retry, retrying: list.running !== null }
            : !list.fresh || list.running !== null ? { kind: "Resolving" } : null),
      } : undefined)];
    }
    const resolution = item.resolution;
    const summary = summaries.resolve(resolution.media_summary);
    return summary === null ? [] : [presentBrowseCandidate({
      ...item, resolution: { ...resolution, media_summary: summary },
    })];
  });
  const label = BROWSE_SOURCE_LABELS[section.source];
  const noun = `${KIND_NOUNS[section.kind]} from ${label.toLowerCase()}`;
  const feedback = useCollectionReadFeedback({
    list, unit: { singular: "result", plural: "results" }, waiting: false, outcome: null,
    returnFocus: () => sectionRef.current,
  });
  return <section ref={sectionRef} tabIndex={-1} className={styles.sourceSection} aria-labelledby={headingId}>
    <h3 id={headingId} className={styles.sourceHeading}>{label}</h3>
    {list.status === "loading" || (!list.current && running) ? <Ruling />
      : refusal !== null ? <Fact line={{ fact: `couldn’t load ${noun}.`, reason: refusal.reason }}
        verbs={refusal.retry ? [{ label: "retry", commandKey: `retry ${noun}`, run: list.retry, busy: running }] : undefined} />
      : failure !== null ? quiet ? <Ruling /> : <Failed error={failure} noun={noun} retry={{ run: list.retry, busy: running }} />
      : list.complete && rows.length === 0 ? <Fact line={{ fact: "no results." }} />
      : null}
    <CollectionView
      returnScope={`Browse.${section.kind}.${section.source}`}
      rows={rows}
      status="ready"
      anchorKey={readKey}
      ariaLabel={`${label} results`}
      empty={null}
      surface={false}
    />
    {feedback.notice}
    {feedback.announcement}
  </section>;
}

export default function BrowsePaneBody() {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const query = useMemo(() => readBrowseQuery(params), [params]);
  const text = query?.text ?? "";
  const queryKey = query === null ? "" : browseHref(query);
  const sections = useMemo(
    () => (query === null || text === "" ? [] : browseSections(query)),
    [query, text],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const chapters = useRef<HTMLDivElement>(null);
  const [reports, setReports] = useState<{ key: string; sections: Readonly<Record<string, SectionStatus>> }>({ key: queryKey, sections: {} });
  const onStatus = useCallback((key: string, status: SectionStatus) => {
    setReports((previous) => ({
      key: queryKey,
      sections: { ...(previous.key === queryKey ? previous.sections : {}), [key]: status },
    }));
  }, [queryKey]);
  const statuses = sections.flatMap((section) => {
    const status = reports.key === queryKey ? reports.sections[keyOf(section)] : undefined;
    return status === undefined ? [] : [status];
  });
  const settled = statuses.filter((status) => status.settled).length;
  const invalid = statuses.some((status) => status.invalid);
  // One cause gets one sentence: every planned section failed, all with one transport. While every
  // settled read is such a failure and some are still out, that sentence may yet come.
  const failures = statuses.flatMap((status) => status.failure ?? []);
  const oneCause = failures.length === settled
    && failures.every((failure) => transportOf(failure) === transportOf(failures[0]));
  const shared = oneCause && failures.length === sections.length && failures.length > 0 ? failures[0] : null;
  const awaiting = oneCause && settled < sections.length;
  useLayoutEffect(() => {
    if (shared !== null && chapters.current?.contains(document.activeElement)) {
      const paneId = chapters.current.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      findPaneLandmarkFocusTarget(paneId)?.focus({ preventScroll: true });
    }
  }, [shared]);
  usePaneReturnReady(query === null || text === "" || settled === sections.length || invalid);
  const onQuery = useCallback(
    (next: BrowseQuery | null) => {
      router.replace(next === null ? "/browse" : browseHref(next));
    },
    [router],
  );
  const queryControls = useMemo(
    () => query === null ? undefined : {
      kind: "Controls" as const,
      content: <BrowseToolbar query={query} inputRef={inputRef} onQuery={onQuery} />,
      focusInput,
    },
    [focusInput, inputRef, onQuery, query],
  );
  usePaneChrome({ query: queryControls, header: { kind: "Section", meta: { kind: "None" } } });
  if (query === null || invalid) return <PaneSurface state={
    <Fact line={{ fact: "browse can’t use this link." }}
      verbs={[{ label: "reset browse", commandKey: "reset browse", run: () => router.replace("/browse") }]} />
  } />;
  return <PaneSurface
    brief="Discover beyond Nexus. Preview first; add only when it belongs."
    empty={<p>Search to discover things beyond Nexus.</p>}
    state={shared === null ? undefined : <Failed error={shared} noun="results" retry={{
      run: () => { for (const status of statuses) void status.refetch().catch(() => {}); },
      busy: statuses.some((status) => status.running),
    }} />}
  >
    <div ref={chapters}>{text ? [...new Set(sections.map((section) => section.kind))].map((kind) => (
      <section key={kind} className={styles.chapter} hidden={shared !== null}>
        <h2 className={styles.chapterHeading}>{BROWSE_KIND_LABELS[kind]}</h2>
        {sections.filter((section) => section.kind === kind).map((section) => (
          <BrowseSourceSection key={keyOf(section)} queryKey={queryKey} text={text} section={section} quiet={awaiting || shared !== null} onStatus={onStatus} />
        ))}
      </section>
    )) : null}</div>
  </PaneSurface>;
}
