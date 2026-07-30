"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import BrowseSection, {
  type BrowseSectionIdentity,
  type BrowseSectionSnapshot,
} from "@/components/browse/BrowseSection";
import Button from "@/components/ui/Button";
import SectionOpener from "@/components/ui/SectionOpener";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneRouter,
  usePaneSearchParams,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import type { BrowseSource } from "@/lib/browse/contract";
import {
  BROWSE_KINDS,
  browseHref,
  decodeBrowseQuery,
  isValidBrowseText,
  normalizeBrowseDraft,
  withBrowseKind,
  withBrowseSource,
  type BrowseQuery,
  type BrowseQueryKind,
} from "@/lib/browse/query";
import {
  browseKindLabel,
  browseSourceLabel,
} from "@/lib/collections/presenters/browse";
import { createBrowseRequestGate } from "@/lib/browse/requestGate";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import styles from "./browse.module.css";

const ALL_SECTIONS: readonly BrowseSectionIdentity[] = [
  { kind: "Pdf", source: "Nexus", sort: "Relevance" },
  { kind: "Epub", source: "Nexus", sort: "Relevance" },
  { kind: "Epub", source: "ProjectGutenberg", sort: "Relevance" },
  { kind: "WebArticle", source: "Nexus", sort: "Relevance" },
  { kind: "WebArticle", source: "Brave", sort: "Relevance" },
  { kind: "Video", source: "Nexus", sort: "Relevance" },
  { kind: "Video", source: "YouTube", sort: "Relevance" },
  { kind: "Podcast", source: "PodcastIndex", sort: "Relevance" },
];

interface BrowseSnapshot {
  readonly queryKey: string;
  readonly sections: Readonly<Record<string, BrowseSectionSnapshot>>;
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

function sectionKey(section: BrowseSectionIdentity): string {
  return `${section.kind}:${section.source}`;
}

function queryKey(query: BrowseQuery): string {
  return browseHref(query);
}

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

function sourceOptions(kind: BrowseQueryKind): readonly BrowseSource[] {
  switch (kind) {
    case "All":
      return [];
    case "Pdf":
      return ["Nexus"];
    case "Epub":
      return ["Nexus", "ProjectGutenberg"];
    case "WebArticle":
      return ["Nexus", "Brave"];
    case "Video":
      return ["Nexus", "YouTube"];
    case "Podcast":
      return ["PodcastIndex"];
  }
}

function visibleSections(query: BrowseQuery): readonly BrowseSectionIdentity[] {
  if (query.kind === "All") return ALL_SECTIONS;
  return ALL_SECTIONS.filter(
    (section) =>
      section.kind === query.kind &&
      (query.source === null || section.source === query.source),
  ).map((section) =>
    section.kind === "Video" && section.source === "YouTube"
      ? { ...section, sort: query.sort }
      : section,
  );
}

function sectionLabel(section: BrowseSectionIdentity): string {
  return `${browseKindLabel(section.kind)} · ${browseSourceLabel(section.source)}`;
}

export default function BrowsePaneBody() {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const decoded = useMemo(() => decodeBrowseQuery(params), [params]);
  const validQuery = decoded.kind === "Valid" ? decoded.query : null;
  const currentQueryKey = validQuery ? queryKey(validQuery) : "Invalid";
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
  const [draft, setDraft] = useState(validQuery?.text ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
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
  const sections = useMemo(
    () => (validQuery?.text ? visibleSections(validQuery) : []),
    [validQuery],
  );

  useEffect(() => {
    if (!validQuery) return;
    setDraft(validQuery.text);
    if (!validQuery.text) {
      const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [currentQueryKey, validQuery]);

  useEffect(() => {
    if (snapshot.queryKey !== currentQueryKey) {
      setSnapshot({ queryKey: currentQueryKey, sections: {} });
    }
  }, [currentQueryKey, snapshot.queryKey]);

  useLayoutEffect(() => {
    committedSnapshotRef.current =
      validQuery && validQuery.text
        ? captureSnapshot(effectiveSnapshot)
        : null;
  }, [effectiveSnapshot, validQuery]);

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
      const key = sectionKey(section);
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

  const sectionStates = useMemo(
    () =>
      sections.map(
        (section) =>
          effectiveSnapshot.sections[sectionKey(section)] ?? {
            kind: "Pending" as const,
            page: null,
          },
      ),
    [effectiveSnapshot.sections, sections],
  );
  const settled =
    sections.length === 0 ||
    sectionStates.every((section) => section.kind !== "Pending");
  const allSectionsObserved = sections.every(
    (section) => effectiveSnapshot.sections[sectionKey(section)] !== undefined,
  );
  usePaneReturnReady(
    decoded.kind === "Invalid" || !validQuery?.text || allSectionsObserved,
  );

  useEffect(() => {
    if (!validQuery?.text) return;
    const firstUsable = sectionStates.some(
      (section) => section.page?.items.length,
    );
    setAnnouncements((current) => {
      const base =
        current.queryKey === currentQueryKey
          ? current
          : { queryKey: currentQueryKey, first: "", settled: "" };
      const first = firstUsable ? base.first || "Results available" : base.first;
      let settledAnnouncement = base.settled;
      if (settled && !settledAnnouncement) {
      const count = sectionStates.reduce(
          (total, section) => total + (section.page?.items.length ?? 0),
        0,
      );
        settledAnnouncement = `${count} ${count === 1 ? "result" : "results"} across ${sections.length} ${sections.length === 1 ? "source" : "sources"}`;
      }
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
    sectionStates,
    sections.length,
    settled,
    validQuery?.text,
  ]);

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "none" },
      pending: false,
    },
  });

  if (decoded.kind === "Invalid") {
    return (
      <div className={styles.root}>
        <SectionOpener heading="Browse" />
        <div className={styles.invalid}>
          <FeedbackNotice
            severity="warning"
            title="This Browse link is invalid"
            message="Reset Browse to start from a valid search."
          />
          <Button onClick={() => router.replace("/browse")}>Reset Browse</Button>
        </div>
      </div>
    );
  }

  const query = decoded.query;
  const sources = sourceOptions(query.kind);
  const commitDraft = () => {
    const text = normalizeBrowseDraft(draft);
    if (text && !isValidBrowseText(text)) return;
    replaceQuery({ ...query, text });
  };

  return (
    <div className={styles.root}>
      <SectionOpener
        heading="Browse"
        standfirst="Discover beyond Nexus. Preview first; add only when it belongs."
      />
      <form
        className={styles.search}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          commitDraft();
        }}
      >
        <label>
          Search
          <input
            ref={inputRef}
            type="search"
            value={draft}
            maxLength={400}
            onChange={(event) => setDraft(event.currentTarget.value)}
            aria-invalid={
              normalizeBrowseDraft(draft) !== "" &&
              !isValidBrowseText(normalizeBrowseDraft(draft))
            }
          />
        </label>
        <Button type="submit">Search</Button>
      </form>
      <div className={styles.chips} role="group" aria-label="Kind">
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
        <div className={styles.facets} role="group" aria-label="Source">
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
        <div className={styles.facets} role="group" aria-label="Sort">
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
      {!query.text ? (
        <p className={styles.statusRow}>Search to discover things beyond Nexus.</p>
      ) : (
        sections.map((section) => {
          const state = effectiveSnapshot.sections[sectionKey(section)];
          return (
            <BrowseSection
              key={`${currentQueryKey}:${sectionKey(section)}`}
              label={sectionLabel(section)}
              query={query.text}
              identity={section}
              restored={state ?? null}
              onController={recordSection}
              runRequest={requestGate.run}
            />
          );
        })
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcements.queryKey === currentQueryKey ? announcements.first : ""}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcements.queryKey === currentQueryKey
          ? announcements.settled
          : ""}
      </div>
    </div>
  );
}
