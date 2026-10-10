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
import { X } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { useViewControls } from "@/components/podcasts/PodcastViewBar";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneSurface from "@/components/ui/PaneSurface";
import PaneToolbar from "@/components/ui/PaneToolbar";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import { isInvalidViewError, type ApiError } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { fetchBrowsePage, type BrowseCandidate } from "@/lib/browse/api";
import {
  BROWSE_KIND_LABELS,
  BROWSE_KINDS,
  BROWSE_SOURCE_LABELS,
  browseDraftInvalid,
  browseHref,
  browseSections,
  browseSourcesFor,
  readBrowseQuery,
  type BrowseQuery,
  type BrowseSection,
} from "@/lib/browse/query";
import { presentBrowseCandidate } from "@/lib/collections/presenters/browse";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  modeledApiError,
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
  | { readonly status: "failed"; readonly error: ApiError }
  | {
      readonly status: "ready";
      readonly items: readonly BrowseCandidate[];
      readonly next: Presence<string>;
      readonly more: "Idle" | "Loading" | ApiError;
    };
type Ready = Extract<Section, { status: "ready" }>;
interface Run {
  readonly key: string;
  readonly sections: Readonly<Record<string, Section>>;
  readonly invalid: boolean;
}

const VISIT = definePaneVisitDataKey<Run>("Browse.Sections");
const keyOf = (section: BrowseSection) => `${section.kind}:${section.source}`;
const until = (time: Presence<string>) =>
  time.kind === "Present"
    ? ` until ${new Date(time.value).toLocaleTimeString()}`
    : "";

/** A section's failure row; any code a section does not model is a defect. */
function sectionErrorMessage(error: ApiError): string {
  // justify-type-assertion: provider failure details are the server's
  // BrowseProviderFailure contract; errors carry no generated schema.
  const details = error.details as {
    readonly retryAt: Presence<string>;
    readonly resetAt: Presence<string>;
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
      return `Rate limited${until(details.retryAt)}`;
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      return `Quota exhausted${until(details.resetAt)}`;
    default:
      throw error;
  }
}

/** The search draft (committed on submit) and the kind/source/sort selects. */
function BrowseToolbar({
  query,
  summary,
  inputRef,
  onQuery,
}: {
  readonly query: BrowseQuery;
  readonly summary: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onQuery: (query: BrowseQuery | null) => void;
}) {
  const helpId = useId();
  const [draft, setDraft] = useState(query.text);
  const [committed, setCommitted] = useState(query.text);
  if (committed !== query.text) {
    setCommitted(query.text);
    setDraft(query.text);
  }
  const normalized = draft.trim().normalize("NFC");
  const invalid = browseDraftInvalid(normalized);
  const sources = browseSourcesFor(query.kind);
  const youTube = query.kind === "Video" && query.source === "YouTube";
  const controls = useViewControls({
    sort: youTube
      ? {
          param: "sort",
          label: "Sort results",
          value: query.sort,
          defaultValue: "Relevance",
          options: [
            { value: "Relevance", label: "Relevance" },
            { value: "Newest", label: "Newest first" },
          ],
        }
      : null,
    filters: [
      {
        param: "kind",
        label: "Kind",
        value: query.kind,
        defaultValue: "All",
        options: [
          { value: "All", label: "All kinds" },
          ...BROWSE_KINDS.map((kind) => ({
            value: kind,
            label: BROWSE_KIND_LABELS[kind],
          })),
        ],
      },
      ...(sources.length < 2 && query.source === null
        ? []
        : [
            {
              param: "source",
              label: "Source",
              value: query.source ?? "",
              defaultValue: "",
              options: [
                { value: "", label: "All sources" },
                ...sources.map((source) => ({
                  value: source,
                  label: BROWSE_SOURCE_LABELS[source],
                })),
              ],
            },
          ]),
    ],
    // A new kind drops source and sort; a new source drops sort.
    onChange: (changes) =>
      onQuery(
        "kind" in changes
          ? {
              ...query,
              kind: BROWSE_KINDS.find((kind) => kind === changes.kind) ?? "All",
              source: null,
              sort: "Relevance",
            }
          : "source" in changes
            ? {
                ...query,
                source:
                  sources.find((source) => source === changes.source) ?? null,
                sort: "Relevance",
              }
            : {
                ...query,
                sort: changes.sort === "Newest" ? "Newest" : "Relevance",
              },
      ),
    onReset:
      draft !== "" || browseHref(query) !== "/browse"
        ? () => {
            setDraft("");
            onQuery(null);
          }
        : undefined,
  });
  return (
    <PaneToolbar
      variant="Collection"
      search={
        <form
          className={styles.searchForm}
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid) {
              inputRef.current?.focus();
              return;
            }
            setDraft(normalized);
            onQuery({ ...query, text: normalized });
          }}
        >
          <Input
            ref={inputRef}
            type="search"
            aria-label="Search"
            size="md"
            value={draft}
            maxLength={200}
            placeholder="Search across sources"
            aria-describedby={invalid ? helpId : undefined}
            aria-invalid={invalid || undefined}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              setDraft("");
            }}
          />
          {draft ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Clear text filter"
              title="Clear text filter"
              onClick={() => {
                setDraft("");
                inputRef.current?.focus({ preventScroll: true });
              }}
            >
              <X size={15} aria-hidden="true" />
            </Button>
          ) : null}
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
      }
      filters={
        <>
          {youTube ? null : (
            <span className={styles.note}>Order: relevance</span>
          )}
          {controls.selects}
        </>
      }
      summary={
        <div className={styles.summary}>
          {query.text && query.text !== draft ? (
            <span className={styles.committedQuery}>Search: {query.text}</span>
          ) : null}
          {controls.chips}
          {invalid ? (
            <p id={helpId} className={styles.note}>
              Use 1–200 characters without control characters.
            </p>
          ) : null}
          {query.text ? <span>{summary}</span> : null}
        </div>
      }
    />
  );
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
  const { inputRef, focusInput } = usePaneCollectionInput();

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
          sections[key] = { ...section, more: "Idle" };
        } else if (section.status !== "loading") sections[key] = section;
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
      settle(
        from === null ? { status: "loading" } : { ...from, more: "Loading" },
      );
      const cursor =
        from?.next.kind === "Present" ? from.next.value : undefined;
      const load = (attempt: AbortSignal) =>
        fetchBrowsePage({ q, ...section, cursor, signal: attempt });
      requestWithRetry(load, signal).then(
        (page) => {
          const items = [...(from?.items ?? []), ...page.items];
          settle({
            status: "ready",
            items,
            next: page.nextCursor,
            more: "Idle",
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
              ? { status: "failed", error: modeled }
              : { ...from, more: modeled },
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
        owned.push(resolution.mediaSummary);
    }
  }
  const summaries = useMediaSummaries(owned);
  const allSettled = settled === sections.length;
  const sourceNoun = sections.length === 1 ? "source" : "sources";
  const summary = [
    `${surfaced} surfaced`,
    `${settled} of ${sections.length} ${sourceNoun} settled`,
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
  const collection = useMemo(
    () =>
      query === null
        ? undefined
        : {
            label: "Browse controls",
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
  usePanePrimaryChrome({
    collection,
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
            const summary = summaries.resolve(resolution.mediaSummary);
            return summary.kind === "Absent"
              ? []
              : [
                  presentBrowseCandidate({
                    ...item,
                    resolution: { ...resolution, mediaSummary: summary.value },
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
          <p className={styles.statusRow} aria-busy="true">
            Loading…
          </p>
        ) : failure !== null ? (
          <div className={styles.statusRow}>
            <span>{sectionErrorMessage(failure)}</span>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Retry ${label}`}
              onClick={request}
            >
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className={styles.statusRow}>No results</p>
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
        state.next.kind === "Present" &&
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
