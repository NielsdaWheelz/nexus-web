"use client";

// Browse fans a query out to independent source sections. Each shared list
// owns traversal, errors and its pane-visit snapshot; the pane tracks first-read readiness.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { podcastActionFacts } from "@/lib/actions/inlineActions";
import { usePodcastActionFacts } from "@/lib/podcasts/usePodcastActionFacts";
import CollectionView from "@/components/collections/CollectionView";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import RadioGroup from "@/components/ui/RadioGroup";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { apiTransportFeedback, type ApiError } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { fetchBrowsePage, type BrowseCandidate } from "@/lib/browse/api";
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
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { usePaneIsActive, usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./browse.module.css";

interface SectionStatus {
  readonly settled: boolean;
  readonly error: ApiError | null;
}
const keyOf = (section: BrowseSection) => `${section.kind}:${section.source}`;
const until = (time: string | null) =>
  time !== null
    ? ` until ${new Date(time).toLocaleTimeString()}`
    : "";

/** A section's failure row; any code a section does not model is a defect. */
function sectionErrorMessage(error: ApiError): string {
  // justify-type-assertion: provider failure details are the server's
  // BrowseProviderFailure contract; errors carry no generated schema.
  const details = error.details as {
    readonly retry_at: string | null;
    readonly reset_at: string | null;
  };
  switch (error.code) {
    case "E_NETWORK":
      return "Connection lost";
    case "E_INVALID_CURSOR":
      return "This search can no longer continue.";
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
      return "Source unavailable";
    case "E_RATE_LIMITED":
      return "Rate limited";
    case "E_BROWSE_PROVIDER_RATE_LIMITED":
      return `Rate limited${until(details.retry_at)}`;
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      return `Quota exhausted${until(details.reset_at)}`;
    default: {
      const transport = apiTransportFeedback(error, "source couldn’t be loaded");
      if (transport !== null) return transport.message ?? transport.title;
      throw error;
    }
  }
}

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
      error: invalid ? "Use up to 200 characters without control characters." : undefined,
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

/** Each kind/source keeps its own visit snapshot and independent provider failure. */
function BrowseSourceSection({ queryKey, text, section, onStatus }: {
  readonly queryKey: string;
  readonly text: string;
  readonly section: BrowseSection;
  readonly onStatus: (key: string, status: SectionStatus) => void;
}) {
  const active = usePaneIsActive();
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
  const error = list.failure?.error ?? null;
  const settled = list.current || error !== null;
  useEffect(() => {
    onStatus(sectionKey, { settled, error });
  }, [queryKey, onStatus, sectionKey, settled, error]);
  const summaries = useMediaSummaries(list.items.flatMap((item) =>
    item.resolution.kind === "InNexusMedia" ? [item.resolution.media_summary] : [],
  ));
  const actionFacts = usePodcastActionFacts({ scope: `Browse.${sectionKey}:${queryKey}`,
    targets: list.items.flatMap(item => item.kind === "Podcast" ? [{ kind: "Discovery" as const, target: item.target }] : []),
    refresh: `${list.current}:${list.running}:${list.requestedKey}`,
  });
  const factsError = actionFacts.status === "loading" ? null : actionFacts.error;
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
  const initialError = list.failure?.op !== "More" ? error : null;
  const invalid = initialError?.code === "E_INVALID_REQUEST" || initialError?.code === "E_INVALID_BROWSE_QUERY";
  const feedback = useCollectionReadFeedback({
    list, unit: { singular: "result", plural: "results" }, waiting: false, outcome: null,
    returnFocus: () => sectionRef.current,
  });
  return <section ref={sectionRef} tabIndex={-1} className={styles.sourceSection} aria-labelledby={headingId}>
    <h3 id={headingId} className={styles.sourceHeading}>{label}</h3>
    {!list.current && initialError === null ? (
      <FeedbackStatus content={{ tone: "Neutral", title: `loading ${label.toLowerCase()}…` }} announcement="None" />
    ) : initialError !== null && !invalid ? (
      <FeedbackNotice
        content={{ tone: "Warning", title: `${label} couldn’t be loaded`, message: sectionErrorMessage(initialError), requestId: initialError.requestId }}
        announcement="Polite"
        actions={[{ label: `retry ${label.toLowerCase()}`, onClick: list.retry, busy: list.running !== null }]}
        returnFocus={() => sectionRef.current}
      />
    ) : list.complete && rows.length === 0 ? (
      <FeedbackStatus content={{ tone: "Neutral", title: "no results" }} announcement="None" />
    ) : null}
    {factsError !== null ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t check podcast subscriptions", requestId: factsError.requestId }} announcement="Polite"
      actions={[{ label: "retry checking subscription", onClick: actionFacts.refetch, busy: actionFacts.status === "failed" ? actionFacts.retrying : actionFacts.status === "ready" && actionFacts.refreshing }]} /> : null}
    <CollectionView
      returnScope={`Browse.${section.kind}.${section.source}`}
      rows={rows}
      status="ready"
      rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: readKey }}
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
  const [reports, setReports] = useState<{ key: string; sections: Readonly<Record<string, SectionStatus>> }>({ key: queryKey, sections: {} });
  const onStatus = useCallback((key: string, status: SectionStatus) => {
    setReports((previous) => ({
      key: queryKey,
      sections: { ...(previous.key === queryKey ? previous.sections : {}), [key]: status },
    }));
  }, [queryKey]);
  const statuses = sections.map((section) => reports.key === queryKey ? reports.sections[keyOf(section)] : undefined);
  const settled = statuses.filter((status) => status?.settled).length;
  const invalid = statuses.some((status) => status?.error?.code === "E_INVALID_BROWSE_QUERY" || status?.error?.code === "E_INVALID_REQUEST");
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
      label: "Search across sources",
      content: <BrowseToolbar query={query} inputRef={inputRef} onQuery={onQuery} />,
      focusInput,
    },
    [focusInput, inputRef, onQuery, query],
  );
  usePaneChrome({ query: queryControls, header: { kind: "Section", meta: { kind: "None" } } });
  if (query === null || invalid) return <PaneSurface state={
    <div className={styles.invalid}>
      <FeedbackNotice content={{ tone: "Warning", title: "This Browse link is invalid", message: "Reset Browse to start from a valid search." }} announcement="Polite" />
      <Button onClick={() => router.replace("/browse")}>Reset Browse</Button>
    </div>
  } />;
  return <PaneSurface
    brief="Discover beyond Nexus. Preview first; add only when it belongs."
    empty={<p>Search to discover things beyond Nexus.</p>}
  >
    {text ? [...new Set(sections.map((section) => section.kind))].map((kind) => (
      <section key={kind} className={styles.chapter}>
        <h2 className={styles.chapterHeading}>{BROWSE_KIND_LABELS[kind]}</h2>
        {sections.filter((section) => section.kind === kind).map((section) => (
          <BrowseSourceSection key={keyOf(section)} queryKey={queryKey} text={text} section={section} onStatus={onStatus} />
        ))}
      </section>
    )) : null}
  </PaneSurface>;
}
