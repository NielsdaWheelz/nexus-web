"use client";

// Browse fans one query out to its planned sections at once; each settles on
// its own. Returning to the pane restores settled sections without asking the
// providers again (docs/modules/workspace.md); unsettled ones are requested.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import RadioGroup from "@/components/ui/RadioGroup";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { isInvalidViewError, type ApiError } from "@/lib/api/client";
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
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  modeledApiError,
  requestWithRetry,
  useThrowLater,
  useVisitSnapshot,
} from "@/lib/api/serverState";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./browse.module.css";

type Section =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: ApiError; readonly retrying: boolean }
  | {
      readonly status: "ready";
      readonly items: readonly BrowseCandidate[];
      readonly next: string | null;
      readonly more: "Idle" | "Loading" | ApiError;
      readonly retrying: boolean;
    };
type Ready = Extract<Section, { status: "ready" }>;
interface Run {
  readonly key: string;
  readonly sections: Readonly<Record<string, Section>>;
  readonly invalid: boolean;
}

const VISIT = definePaneVisitDataKey<Run>("Browse.Sections");
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
    default:
      throw error;
  }
}

/** Browse owns submitted text, exclusive kind/source choices and provider order. */
function BrowseToolbar({ query, summary, inputRef, onQuery }: {
  readonly query: BrowseQuery;
  readonly summary: string;
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
      choices: [{ value: "Relevance", label: "Relevance" }, { value: "Newest", label: "Newest first" }],
      onChange: (value) => onQuery({ ...query, sort: value === "Newest" ? "Newest" : "Relevance" }),
    } : undefined}
    chips={{ items: chips, onRemove: (id) => onQuery(withBrowseFilters(query, {
      kind: id === "kind" ? "All" : query.kind,
      source: null,
    })) }}
    status={{ id: statusId, visible: true, content: <>
      {mixedSources ? <span>Other sources: relevance</span> : null}
      {!youTube ? <span>Order: relevance</span> : null}
      <span id={statusId}>{query.text ? summary : "Enter a search term to browse sources."}</span>
    </> }}
    onReset={draft || browseHref(query) !== "/browse" ? () => { setDraft(""); onQuery(null); } : undefined}
  />;
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
  const fail = useThrowLater();
  const idPrefix = useId();
  const { inputRef, focusInput } = usePaneQueryInput();

  // The visit keeps settled sections; one still loading is asked again.
  const runRef = useRef<Run | null>(null);
  const restored = useVisitSnapshot(
    VISIT,
    queryKey,
    useCallback(() => {
      const run = runRef.current;
      if (run === null || run.key === "") return null;
      const sections: Record<string, Section> = {};
      for (const [key, section] of Object.entries(run.sections)) {
        if (section.status === "ready" && section.more === "Loading") {
          sections[key] = { ...section, more: "Idle", retrying: false };
        } else if (section.status !== "loading") sections[key] = { ...section, retrying: false };
      }
      return { ...run, sections };
    }, []),
  );
  const arrival = restored ?? { key: queryKey, sections: {}, invalid: false };
  const [state, setState] = useState(arrival);
  const run = state.key === queryKey ? state : arrival;
  runRef.current = run;
  const controller = useRef(new AbortController());

  // One request: a section's first page (from null) or its next page.
  const fetchSection = useCallback(
    (q: string, section: BrowseSection, from: Ready | null) => {
      const key = keyOf(section);
      const signal = controller.current.signal;
      const settle = (next: Section) =>
        setState((current) => ({
          ...current,
          sections: { ...current.sections, [key]: next },
        }));
      const previous = runRef.current?.sections[key];
      if (previous?.status === "failed" && previous.retrying || from?.retrying || from?.more === "Loading") return;
      settle(from === null
        ? previous?.status === "failed" ? { ...previous, retrying: true } : { status: "loading" }
        : typeof from.more === "object" ? { ...from, retrying: true } : { ...from, more: "Loading" });
      const cursor =
        from?.next != null ? from.next : undefined;
      const load = (attempt: AbortSignal) =>
        fetchBrowsePage({ q, ...section, cursor, signal: attempt });
      requestWithRetry(load, signal).then(
        (page) => {
          if (signal.aborted) return;
          const items = [...(from?.items ?? []), ...page.items];
          settle({
            status: "ready",
            items,
            next: page.next_cursor,
            more: "Idle",
            retrying: false,
          });
        },
        (error: unknown) => {
          const modeled = signal.aborted ? null : modeledApiError(error, fail);
          if (modeled === null) return;
          // The server refused the query or cursor: its own check, a bound
          // such as q over 200 code points, or a cursor it no longer reads.
          if (
            modeled.code === "E_INVALID_BROWSE_QUERY" ||
            isInvalidViewError(modeled)
          ) {
            setState((current) => ({ ...current, invalid: true }));
            return;
          }
          settle(
            from === null
              ? { status: "failed", error: modeled, retrying: false }
              : { ...from, more: modeled, retrying: false },
          );
        },
      );
    },
    [fail],
  );

  useEffect(() => {
    controller.current = new AbortController();
    setState(restored ?? { key: queryKey, sections: {}, invalid: false });
    for (const section of sections) {
      if (restored?.sections[keyOf(section)] === undefined) {
        fetchSection(text, section, null);
      }
    }
    const current = controller.current;
    return () => current.abort();
  }, [fetchSection, queryKey, restored, sections, text]);

  let surfaced = 0;
  let settled = 0;
  let failed = 0;
  const owned = [];
  for (const section of sections) {
    const state = run.sections[keyOf(section)];
    if (state === undefined || state.status === "loading") continue;
    settled += 1;
    if (state.status === "failed") {
      failed += 1;
      continue;
    }
    surfaced += state.items.length;
    for (const { resolution } of state.items) {
      if (resolution.kind === "InNexusMedia")
        owned.push(resolution.media_summary);
    }
  }
  const summaries = useMediaSummaries(owned);
  const allSettled = settled === sections.length;
  const searchNoun = sections.length === 1 ? "search" : "searches";
  const summary = [
    `${surfaced} surfaced`,
    `${settled} of ${sections.length} ${searchNoun} finished`,
    ...(failed > 0 ? [`${failed} unavailable`] : []),
  ].join(" · ");
  usePaneReturnReady(
    query === null || text === "" || allSettled || run.invalid,
  );
  // Each query announces "Results available", then its summary, once each.
  const phase = allSettled ? summary : surfaced > 0 ? "Results available" : "";
  const [said, setSaid] = useState({ key: queryKey, text: "" });
  if (
    said.key !== queryKey ||
    (said.text === "" && phase !== "") ||
    (said.text === "Results available" && allSettled)
  ) {
    setSaid({ key: queryKey, text: phase });
  }

  const onQuery = useCallback(
    (next: BrowseQuery | null) =>
      router.replace(next === null ? "/browse" : browseHref(next), {
        viewTransition: { kind: "collection-reflow" },
      }),
    [router],
  );
  const queryControls = useMemo(
    () =>
      query === null
        ? undefined
        : {
            kind: "Controls" as const,
            label: "Search across sources",
            content: (
              <BrowseToolbar
                query={query}
                summary={summary}
                inputRef={inputRef}
                onQuery={onQuery}
              />
            ),
            focusInput,
          },
    [focusInput, inputRef, onQuery, query, summary],
  );
  usePaneChrome({
    query: queryControls,
    header: { kind: "Section", meta: { kind: "None" } },
  });

  if (query === null || run.invalid) {
    return (
      <PaneSurface
        state={
          <div className={styles.invalid}>
            <FeedbackNotice
              content={{
                tone: "Warning",
                title: "This Browse link is invalid",
                message: "Reset Browse to start from a valid search.",
              }}
              announcement="Polite"
            />
            <Button onClick={() => router.replace("/browse")}>
              Reset Browse
            </Button>
          </div>
        }
      />
    );
  }

  const renderSection = (section: BrowseSection) => {
    const key = keyOf(section);
    const label = BROWSE_SOURCE_LABELS[section.source];
    const state = run.sections[key] ?? { status: "loading" };
    const rows =
      state.status !== "ready"
        ? []
        : state.items.flatMap((item) => {
            if (item.resolution.kind !== "InNexusMedia") {
              return [presentBrowseCandidate(item)];
            }
            const resolution = item.resolution;
            const summary = summaries.resolve(resolution.media_summary);
            return summary === null
              ? []
              : [
                  presentBrowseCandidate({
                    ...item,
                    resolution: { ...resolution, media_summary: summary },
                  }),
                ];
          });
    const failure =
      state.status === "failed"
        ? state.error
        : state.status === "ready" && typeof state.more === "object"
          ? state.more
          : null;
    const request = () =>
      fetchSection(text, section, state.status === "ready" ? state : null);
    return (
      <section
        key={key}
        className={styles.sourceSection}
        aria-labelledby={`${idPrefix}${key}`}
      >
        <h3 id={`${idPrefix}${key}`} className={styles.sourceHeading}>
          {label}
        </h3>
        {state.status === "loading" ? (
          <FeedbackStatus content={{ tone: "Neutral", title: `loading ${label.toLowerCase()}…` }} announcement="None" />
        ) : failure !== null ? (
          <FeedbackNotice
            content={{ tone: "Warning", title: `${label} couldn’t be loaded`, message: sectionErrorMessage(failure), requestId: failure.requestId }}
            announcement="Polite"
            actions={[{ label: `retry ${label.toLowerCase()}`, onClick: request, busy: state.retrying }]}
          />
        ) : rows.length === 0 ? (
          <FeedbackStatus content={{ tone: "Neutral", title: "no results" }} announcement="None" />
        ) : null}
        <CollectionView
          returnScope={`Browse.${section.kind}.${section.source}`}
          rows={rows}
          status="ready"
          ariaLabel={`${label} results`}
          empty={null}
          surface={false}
        />
        {state.status === "ready" &&
        state.next !== null &&
        failure === null ? (
          <div className={styles.continuation}>
            <Button
              size="sm"
              variant="secondary"
              loading={state.more === "Loading"}
              onClick={request}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <PaneSurface
      brief="Discover beyond Nexus. Preview first; add only when it belongs."
      state={
        text ? (
          <div
            className="sr-only"
            aria-label="Browse result announcements"
            aria-live="polite"
            aria-atomic="true"
          >
            {said.text}
          </div>
        ) : undefined
      }
      empty={<p>Search to discover things beyond Nexus.</p>}
    >
      {text
        ? [...new Set(sections.map((section) => section.kind))].map((kind) => (
            <section key={kind} className={styles.chapter}>
              <h2 className={styles.chapterHeading}>
                {BROWSE_KIND_LABELS[kind]}
              </h2>
              {sections
                .filter((section) => section.kind === kind)
                .map(renderSection)}
            </section>
          ))
        : null}
    </PaneSurface>
  );
}
