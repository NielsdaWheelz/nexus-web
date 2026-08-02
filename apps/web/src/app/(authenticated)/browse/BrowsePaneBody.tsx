"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import BrowseSection, {
  type BrowseSectionSnapshot,
} from "@/components/browse/BrowseSection";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import {
  browseKindLabel,
  browseSourceLabel,
} from "@/lib/collections/presenters/browse";
import {
  BROWSE_KINDS,
  browseResultChapters,
  browseSectionKey,
  browseSourcesForKind,
  type BrowseSectionIdentity,
} from "@/lib/browse/plan";
import {
  browseHref,
  decodeBrowseQuery,
  isValidBrowseText,
  normalizeBrowseDraft,
  withBrowseKind,
  withBrowseSource,
  type BrowseQuery,
} from "@/lib/browse/query";
import { createBrowseRequestGate } from "@/lib/browse/requestGate";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneRouter,
  usePaneSearchParams,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import styles from "./browse.module.css";

interface BrowseSnapshot {
  readonly queryKey: string;
  readonly sections: Readonly<Record<string, BrowseSectionSnapshot>>;
}

interface BrowseRunSummary {
  readonly surfaced: number;
  readonly settledSources: number;
  readonly sourceCount: number;
  readonly failedSources: number;
}

const INTERRUPTED_SECTION_FAILURE = {
  status: 0,
  code: "E_BROWSE_REQUEST_INTERRUPTED",
  message: "Browse request stopped when the pane changed",
  requestId: null,
  details: null,
} as const;

const BROWSE_VISIT_DATA =
  definePaneVisitDataKey<BrowseSnapshot>("Browse.Sections");

function captureSnapshot(snapshot: BrowseSnapshot): BrowseSnapshot {
  return {
    ...snapshot,
    sections: Object.fromEntries(
      Object.entries(snapshot.sections).map(([key, section]) => [
        key,
        section.kind === "Pending"
          ? {
              kind: "Failed",
              page: null,
              failure: INTERRUPTED_SECTION_FAILURE,
            }
          : section,
      ]),
    ),
  };
}

function browseRunSummary(
  sections: readonly BrowseSectionIdentity[],
  snapshot: BrowseSnapshot,
): BrowseRunSummary {
  return sections.reduce<BrowseRunSummary>(
    (summary, section) => {
      const state = snapshot.sections[browseSectionKey(section)];
      if (!state) return summary;
      return {
        surfaced: summary.surfaced + (state.page?.items.length ?? 0),
        settledSources:
          summary.settledSources + (state.kind === "Pending" ? 0 : 1),
        sourceCount: summary.sourceCount,
        failedSources:
          summary.failedSources + (state.kind === "Failed" ? 1 : 0),
      };
    },
    {
      surfaced: 0,
      settledSources: 0,
      sourceCount: sections.length,
      failedSources: 0,
    },
  );
}

function browseRunSummaryText(summary: BrowseRunSummary): string {
  const sourceNoun = summary.sourceCount === 1 ? "source" : "sources";
  const parts = [
    `${summary.surfaced} surfaced`,
    `${summary.settledSources} of ${summary.sourceCount} ${sourceNoun} settled`,
  ];
  if (summary.failedSources > 0) {
    parts.push(`${summary.failedSources} unavailable`);
  }
  return parts.join(" · ");
}

export default function BrowsePaneBody() {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const decoded = useMemo(() => decodeBrowseQuery(params), [params]);
  const validQuery = decoded.kind === "Valid" ? decoded.query : null;
  const validQueryText = validQuery?.text;
  const currentQueryKey = validQuery ? browseHref(validQuery) : "Invalid";
  const [requestGate] = useState(() => createBrowseRequestGate(3));
  const committedSnapshotRef = useRef<BrowseSnapshot | null>(null);
  const restored = usePaneVisitData(BROWSE_VISIT_DATA, () =>
    committedSnapshotRef.current,
  );
  const [snapshot, setSnapshot] = useState<BrowseSnapshot>(
    () =>
      restored ?? {
        queryKey: currentQueryKey,
        sections: {},
      },
  );
  const [draft, setDraft] = useState(validQueryText ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const draftHelpId = useId();
  const [announcements, setAnnouncements] = useState<{
    readonly queryKey: string;
    readonly first: string;
    readonly settled: string;
  }>({ queryKey: currentQueryKey, first: "", settled: "" });

  const effectiveSnapshot = useMemo(
    () =>
      snapshot.queryKey === currentQueryKey
        ? snapshot
        : { queryKey: currentQueryKey, sections: {} },
    [currentQueryKey, snapshot],
  );
  const chapters = useMemo(
    () => (validQuery?.text ? browseResultChapters(validQuery) : []),
    [validQuery],
  );
  const sections = useMemo(
    () => chapters.flatMap((chapter) => chapter.sections),
    [chapters],
  );
  const runSummary = useMemo(
    () => browseRunSummary(sections, effectiveSnapshot),
    [effectiveSnapshot, sections],
  );
  const allSectionsObserved = sections.every(
    (section) =>
      effectiveSnapshot.sections[browseSectionKey(section)] !== undefined,
  );

  useEffect(() => {
    if (validQueryText === undefined) return;
    setDraft(validQueryText);
    if (!validQueryText) {
      const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [currentQueryKey, validQueryText]);

  useEffect(() => {
    if (snapshot.queryKey !== currentQueryKey) {
      setSnapshot({ queryKey: currentQueryKey, sections: {} });
    }
  }, [currentQueryKey, snapshot.queryKey]);

  useLayoutEffect(() => {
    committedSnapshotRef.current =
      validQuery?.text
        ? captureSnapshot(effectiveSnapshot)
        : null;
  }, [effectiveSnapshot, validQuery?.text]);

  const replaceQuery = useCallback(
    (next: BrowseQuery) => {
      router.replace(browseHref(next), {
        viewTransition: { kind: "collection-reflow" },
      });
    },
    [router],
  );

  const recordSection = useCallback(
    (section: BrowseSectionIdentity, next: BrowseSectionSnapshot) => {
      const key = browseSectionKey(section);
      setSnapshot((current) => {
        const base =
          current.queryKey === currentQueryKey
            ? current
            : { queryKey: currentQueryKey, sections: {} };
        return {
          ...base,
          sections: { ...base.sections, [key]: next },
        };
      });
    },
    [currentQueryKey],
  );

  usePaneReturnReady(
    decoded.kind === "Invalid" || !validQuery?.text || allSectionsObserved,
  );

  useEffect(() => {
    if (!validQuery?.text) return;
    const firstUsable = runSummary.surfaced > 0;
    const settled = runSummary.settledSources === runSummary.sourceCount;
    setAnnouncements((current) => {
      const base =
        current.queryKey === currentQueryKey
          ? current
          : { queryKey: currentQueryKey, first: "", settled: "" };
      const first = firstUsable ? base.first || "Results available" : base.first;
      const settledAnnouncement =
        settled && !base.settled ? browseRunSummaryText(runSummary) : base.settled;
      return first === current.first &&
        settledAnnouncement === current.settled &&
        current.queryKey === currentQueryKey
        ? current
        : {
            queryKey: currentQueryKey,
            first,
            settled: settledAnnouncement,
          };
    });
  }, [
    currentQueryKey,
    runSummary,
    validQuery?.text,
  ]);

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "none" },
      pending: false,
    },
  });

  const query = decoded.kind === "Valid" ? decoded.query : null;
  const sources = query ? browseSourcesForKind(query.kind) : [];
  const normalizedDraft = normalizeBrowseDraft(draft);
  const invalidDraft =
    normalizedDraft !== "" && !isValidBrowseText(normalizedDraft);
  const toolbar = query ? (
    <div className={styles.toolbar}>
      <form
        className={styles.searchForm}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (invalidDraft) {
            inputRef.current?.focus();
          } else {
            replaceQuery({ ...query, text: normalizedDraft });
          }
        }}
      >
        <label>
          Search
          <Input
            ref={inputRef}
            type="search"
            size="md"
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.currentTarget.value)}
            aria-describedby={invalidDraft ? draftHelpId : undefined}
            aria-invalid={invalidDraft || undefined}
          />
        </label>
        <Button type="submit">Search</Button>
      </form>
      {invalidDraft ? (
        <p id={draftHelpId} className={styles.validationHelp}>
          Use 1–200 characters without control characters.
        </p>
      ) : null}
      <div className={styles.facets}>
        <div className={styles.facetGroup} role="group" aria-label="Kind">
          {BROWSE_KINDS.map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant="pill"
              aria-pressed={query.kind === kind}
              onClick={() => replaceQuery(withBrowseKind(query, kind))}
            >
              {kind === "All" ? "All" : browseKindLabel(kind)}
            </Button>
          ))}
        </div>
        {sources.length > 1 ? (
          <div className={styles.facetGroup} role="group" aria-label="Source">
            <Button
              size="sm"
              variant="pill"
              aria-pressed={query.source === null}
              onClick={() => replaceQuery(withBrowseSource(query, null))}
            >
              All sources
            </Button>
            {sources.map((source) => (
              <Button
                key={source}
                size="sm"
                variant="pill"
                aria-pressed={query.source === source}
                onClick={() => replaceQuery(withBrowseSource(query, source))}
              >
                {browseSourceLabel(source)}
              </Button>
            ))}
          </div>
        ) : null}
        {query.kind === "Video" && query.source === "YouTube" ? (
          <div className={styles.facetGroup} role="group" aria-label="Sort">
            {(["Relevance", "Newest"] as const).map((sort) => (
              <Button
                key={sort}
                size="sm"
                variant="pill"
                aria-pressed={query.sort === sort}
                onClick={() => replaceQuery({ ...query, sort })}
              >
                {sort}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  ) : undefined;
  const runState = query?.text ? (
    <>
      <p className={styles.summary}>{browseRunSummaryText(runSummary)}</p>
      <div
        className="sr-only"
        aria-label="Browse result announcements"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcements.queryKey === currentQueryKey
          ? announcements.settled || announcements.first
          : ""}
      </div>
    </>
  ) : undefined;

  return (
    <PaneSurface
      opener={
        <SectionOpener
          heading="Browse"
          standfirst={
            query
              ? "Discover beyond Nexus. Preview first; add only when it belongs."
              : undefined
          }
        />
      }
      toolbar={toolbar}
      state={
        decoded.kind === "Invalid" ? (
          <div className={styles.invalid}>
            <FeedbackNotice
              content={{
                tone: "Warning",
                title: "This Browse link is invalid",
                message: "Reset Browse to start from a valid search.",
              }}
              announcement="Polite"
            />
            <Button onClick={() => router.replace("/browse")}>Reset Browse</Button>
          </div>
        ) : (
          runState
        )
      }
      empty={
        query && !query.text ? (
          <p>Search to discover things beyond Nexus.</p>
        ) : undefined
      }
    >
      {query?.text
        ? chapters.map((chapter) => (
            <section key={chapter.kind} className={styles.chapter}>
              <h2 className={styles.chapterHeading}>
                {browseKindLabel(chapter.kind)}
              </h2>
              {chapter.sections.map((section) => {
                const state = effectiveSnapshot.sections[browseSectionKey(section)];
                return (
                  <BrowseSection
                    key={`${currentQueryKey}:${browseSectionKey(section)}`}
                    label={browseSourceLabel(section.source)}
                    query={query.text}
                    identity={section}
                    restored={state ?? null}
                    onController={recordSection}
                    runRequest={requestGate.run}
                  />
                );
              })}
            </section>
          ))
        : null}
    </PaneSurface>
  );
}
