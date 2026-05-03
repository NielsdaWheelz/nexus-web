"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { FileText, Mic, Play, Video } from "lucide-react";
import LibraryTargetPicker, {
  type LibraryTargetPickerItem,
} from "@/components/LibraryTargetPicker";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SectionCard from "@/components/ui/SectionCard";
import { apiFetch } from "@/lib/api/client";
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { subscribeToPodcast } from "../podcasts/podcastSubscriptions";
import styles from "./page.module.css";

type BrowseSectionType = "documents" | "videos" | "podcasts" | "podcast_episodes";

type BrowsePageInfo = {
  has_more: boolean;
  next_cursor: string | null;
};

type BrowseDocumentResult = {
  type: "documents";
  title: string;
  description: string | null;
  url: string;
  document_kind: "pdf" | "epub" | "web_article";
  site_name: string | null;
  source_label?: string | null;
  source_type?: string | null;
  media_id?: string | null;
};

type BrowseVideoResult = {
  type: "videos";
  provider_video_id: string;
  title: string;
  description: string | null;
  watch_url: string;
  channel_title: string | null;
  published_at: string | null;
  thumbnail_url: string | null;
  media_id?: string | null;
};

type BrowsePodcastResult = {
  type: "podcasts";
  podcast_id: string | null;
  provider_podcast_id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
};

type BrowseEpisodeResult = {
  type: "podcast_episodes";
  podcast_id: string | null;
  provider_podcast_id: string;
  provider_episode_id: string;
  podcast_title: string;
  podcast_author: string | null;
  podcast_image_url: string | null;
  title: string;
  audio_url: string;
  published_at: string | null;
  duration_seconds: number | null;
  feed_url: string;
  website_url: string | null;
  description: string | null;
};

type BrowseResult =
  | BrowseDocumentResult
  | BrowseVideoResult
  | BrowsePodcastResult
  | BrowseEpisodeResult;

type BrowseSectionData = {
  results: BrowseResult[];
  page: BrowsePageInfo;
};

type BrowseResponse = {
  data: {
    query?: string;
    sections: Partial<Record<BrowseSectionType, BrowseSectionData>>;
  };
};

type LibrarySummary = {
  id: string;
  name: string;
  is_default: boolean;
  color?: string | null;
};

const BROWSE_TYPES: BrowseSectionType[] = [
  "documents",
  "videos",
  "podcasts",
  "podcast_episodes",
];

const TYPE_LABELS: Record<BrowseSectionType, string> = {
  documents: "Documents",
  videos: "Videos",
  podcasts: "Podcasts",
  podcast_episodes: "Episodes",
};

function emptySections(): Record<BrowseSectionType, BrowseSectionData> {
  return {
    documents: { results: [], page: { has_more: false, next_cursor: null } },
    videos: { results: [], page: { has_more: false, next_cursor: null } },
    podcasts: { results: [], page: { has_more: false, next_cursor: null } },
    podcast_episodes: { results: [], page: { has_more: false, next_cursor: null } },
  };
}

function normalizeBrowseQuery(value: string | null): string {
  return value ? value.trim() : "";
}

function isBrowseSectionType(value: string): value is BrowseSectionType {
  return (
    value === "documents" ||
    value === "videos" ||
    value === "podcasts" ||
    value === "podcast_episodes"
  );
}

function parseVisibleTypes(searchParams: URLSearchParams): BrowseSectionType[] {
  if (!searchParams.has("types")) {
    return [...BROWSE_TYPES];
  }
  const raw = searchParams.getAll("types").join(",");
  if (raw === "") {
    return [];
  }
  const seen = new Set<BrowseSectionType>();
  for (const part of raw.split(",")) {
    if (isBrowseSectionType(part) && !seen.has(part)) {
      seen.add(part);
    }
  }
  return seen.size > 0 ? BROWSE_TYPES.filter((type) => seen.has(type)) : [];
}

function buildBrowseHref(query: string, visibleTypes: BrowseSectionType[]): string {
  const params = new URLSearchParams();
  const trimmedQuery = query.trim();
  if (trimmedQuery) {
    params.set("q", trimmedQuery);
  }
  if (visibleTypes.length === 0) {
    params.set("types", "");
  } else if (visibleTypes.length < BROWSE_TYPES.length) {
    params.set("types", visibleTypes.join(","));
  }
  const search = params.toString();
  return search ? `/browse?${search}` : "/browse";
}

function formatEpisodeMeta(result: BrowseEpisodeResult): string {
  const bits: string[] = [];
  if (result.published_at) {
    bits.push(`Published ${new Date(result.published_at).toLocaleDateString()}`);
  }
  if (result.duration_seconds) {
    bits.push(`${Math.round(result.duration_seconds / 60)} min`);
  }
  return bits.length > 0 ? bits.join(" · ") : "Recent episode preview";
}

function getDocumentSourceLabel(result: BrowseDocumentResult): string | null {
  if (typeof result.source_label === "string" && result.source_label.trim()) {
    return result.source_label.trim();
  }
  if (result.source_type === "nexus") {
    return "Nexus";
  }
  if (result.source_type === "project_gutenberg") {
    return "Project Gutenberg";
  }
  if (result.site_name && result.site_name.trim()) {
    return result.site_name.trim();
  }
  return null;
}

function isProjectGutenbergDocument(result: BrowseDocumentResult): boolean {
  if (result.source_type === "project_gutenberg") {
    return true;
  }
  const sourceLabel = getDocumentSourceLabel(result);
  return sourceLabel === "Project Gutenberg";
}

function getDocumentActionLabel(result: BrowseDocumentResult, busy: boolean): string {
  if (result.media_id) {
    return busy ? "Opening..." : "Open";
  }
  if (isProjectGutenbergDocument(result)) {
    return busy ? "Importing..." : "Import";
  }
  return busy ? "Adding..." : "Add";
}

function getDocumentLibraryActionLabel(result: BrowseDocumentResult): string {
  return isProjectGutenbergDocument(result) ? "Import + library" : "Add + library";
}

function getDocumentFallbackDescription(result: BrowseDocumentResult): string {
  if (result.media_id) {
    return "Open this document in the reader.";
  }
  if (isProjectGutenbergDocument(result)) {
    return "Import this Project Gutenberg document into the reader.";
  }
  return "Add this document to open it in the reader.";
}

function normalizeSections(data: BrowseResponse["data"]): Record<BrowseSectionType, BrowseSectionData> {
  const nextSections = emptySections();
  for (const type of BROWSE_TYPES) {
    const section = data.sections[type];
    if (section) {
      nextSections[type] = section;
    }
  }
  return nextSections;
}

function replaceSection(
  current: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType,
  nextSection: BrowseSectionData
): Record<BrowseSectionType, BrowseSectionData> {
  return {
    ...current,
    [sectionType]: nextSection,
  };
}

function updateSectionResults<T extends BrowseResult>(
  results: BrowseResult[],
  match: (row: BrowseResult) => row is T,
  update: (row: T) => T
): BrowseResult[] {
  return results.map((row) => (match(row) ? update(row) : row));
}

function isPodcastResult(row: BrowseResult): row is BrowsePodcastResult {
  return row.type === "podcasts";
}

function isPodcastEpisodeResult(row: BrowseResult): row is BrowseEpisodeResult {
  return row.type === "podcast_episodes";
}

function isDocumentResult(row: BrowseResult): row is BrowseDocumentResult {
  return row.type === "documents";
}

function isVideoResult(row: BrowseResult): row is BrowseVideoResult {
  return row.type === "videos";
}

function getSection(
  sections: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType
): BrowseSectionData {
  return sections[sectionType];
}

function getSectionResults(
  sections: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType
): BrowseResult[] {
  return getSection(sections, sectionType).results;
}

function getSectionPage(
  sections: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType
): BrowsePageInfo {
  return getSection(sections, sectionType).page;
}

function mergeSectionResults(
  current: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType,
  nextSection: BrowseSectionData
): Record<BrowseSectionType, BrowseSectionData> {
  return replaceSection(current, sectionType, {
    results: [...getSectionResults(current, sectionType), ...nextSection.results],
    page: nextSection.page,
  });
}

function updateSection(
  current: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType,
  updateResults: (results: BrowseResult[]) => BrowseResult[]
): Record<BrowseSectionType, BrowseSectionData> {
  return replaceSection(current, sectionType, {
    ...getSection(current, sectionType),
    results: updateResults(getSectionResults(current, sectionType)),
  });
}

export default function BrowsePaneBody() {
  const paneRouter = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();
  const appliedQuery = normalizeBrowseQuery(paneSearchParams.get("q"));
  const visibleTypes = parseVisibleTypes(paneSearchParams);

  const [draftQuery, setDraftQuery] = useState(appliedQuery);
  const [sections, setSections] = useState<Record<BrowseSectionType, BrowseSectionData>>(emptySections);
  const [searching, setSearching] = useState(false);
  const [loadingMoreTypes, setLoadingMoreTypes] = useState<Set<BrowseSectionType>>(new Set());
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [hasSearched, setHasSearched] = useState(Boolean(appliedQuery));
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [librariesLoaded, setLibrariesLoaded] = useState(false);

  useEffect(() => {
    setDraftQuery(appliedQuery);
  }, [appliedQuery]);

  useEffect(() => {
    let cancelled = false;
    if (!appliedQuery) {
      setSections(emptySections());
      setHasSearched(false);
      setSearching(false);
      setError(null);
      return () => {
        cancelled = true;
      };
    }

    setSearching(true);
    setError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({
          q: appliedQuery,
          limit: "10",
        });
        const response = await apiFetch<BrowseResponse>(`/api/browse?${params.toString()}`);
        if (cancelled) {
          return;
        }
        setSections(normalizeSections(response.data));
        setHasSearched(true);
      } catch (searchError) {
        if (cancelled) {
          return;
        }
        setSections(emptySections());
        setHasSearched(true);
        setError(toFeedback(searchError, { fallback: "Browse failed" }));
      } finally {
        if (!cancelled) {
          setSearching(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appliedQuery]);

  async function loadLibraries() {
    if (librariesLoading || librariesLoaded) {
      return;
    }
    setLibrariesLoading(true);
    try {
      const response = await apiFetch<{ data: LibrarySummary[] }>("/api/libraries");
      setLibraries(
        response.data
          .filter((library) => !library.is_default)
          .map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color ?? null,
            isInLibrary: false,
            canAdd: true,
            canRemove: false,
          }))
      );
      setLibrariesLoaded(true);
    } finally {
      setLibrariesLoading(false);
    }
  }

  function updateVisibleTypes(nextVisibleTypes: BrowseSectionType[]) {
    paneRouter.replace(buildBrowseHref(appliedQuery, nextVisibleTypes));
  }

  async function ensureAndOpenPodcast(result: BrowsePodcastResult | BrowseEpisodeResult) {
    if (result.podcast_id) {
      requestOpenInAppPane(`/podcasts/${result.podcast_id}`);
      return;
    }

    const busyKey = `podcast:${result.provider_podcast_id}`;
    setBusyKeys((current) => new Set(current).add(busyKey));
    setError(null);
    try {
      const response = await apiFetch<{ data: { podcast_id: string } }>("/api/podcasts/ensure", {
        method: "POST",
        body: JSON.stringify({
          provider_podcast_id: result.provider_podcast_id,
          title: result.type === "podcasts" ? result.title : result.podcast_title,
          author: result.type === "podcasts" ? result.author : result.podcast_author,
          feed_url: result.feed_url,
          website_url: result.website_url,
          image_url: result.type === "podcasts" ? result.image_url : result.podcast_image_url,
          description: result.description,
        }),
      });
      const podcastId = response.data.podcast_id;
      setSections((current) =>
        updateSection(
          updateSection(current, "podcasts", (results) =>
            updateSectionResults(results, isPodcastResult, (row) =>
              row.provider_podcast_id === result.provider_podcast_id
                ? { ...row, podcast_id: podcastId }
                : row
            )
          ),
          "podcast_episodes",
          (results) =>
            updateSectionResults(results, isPodcastEpisodeResult, (row) =>
              row.provider_podcast_id === result.provider_podcast_id
                ? { ...row, podcast_id: podcastId }
                : row
            )
        )
      );
      requestOpenInAppPane(`/podcasts/${podcastId}`);
    } catch (openError) {
      setError(toFeedback(openError, { fallback: "Failed to open podcast" }));
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current);
        next.delete(busyKey);
        return next;
      });
    }
  }

  async function followPodcast(result: BrowsePodcastResult, libraryId: string | null = null) {
    const busyKey = `podcast:${result.provider_podcast_id}`;
    setBusyKeys((current) => new Set(current).add(busyKey));
    setError(null);
    try {
      const response = await subscribeToPodcast({
        provider_podcast_id: result.provider_podcast_id,
        title: result.title,
        author: result.author,
        feed_url: result.feed_url,
        website_url: result.website_url,
        image_url: result.image_url,
        description: result.description,
        library_id: libraryId,
      });
      setSections((current) =>
        updateSection(current, "podcasts", (results) =>
          updateSectionResults(results, isPodcastResult, (row) =>
            row.provider_podcast_id === result.provider_podcast_id
              ? { ...row, podcast_id: response.podcast_id }
              : row
          )
        )
      );
    } catch (followError) {
      setError(toFeedback(followError, { fallback: "Failed to follow podcast" }));
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current);
        next.delete(busyKey);
        return next;
      });
    }
  }

  async function addAndOpenResult(
    result: BrowseDocumentResult | BrowseVideoResult,
    libraryId: string | null = null
  ) {
    if (result.media_id) {
      requestOpenInAppPane(`/media/${result.media_id}`);
      return;
    }

    const busyKey =
      result.type === "documents" ? `document:${result.url}` : `video:${result.provider_video_id}`;
    setBusyKeys((current) => new Set(current).add(busyKey));
    setError(null);
    try {
      const added = await addMediaFromUrl({
        url: result.type === "documents" ? result.url : result.watch_url,
        libraryId,
      });
      setSections((current) =>
        updateSection(current, result.type, (results) => {
          if (result.type === "documents") {
            return updateSectionResults(results, isDocumentResult, (row) =>
              row.url === result.url ? { ...row, media_id: added.mediaId } : row
            );
          }
          return updateSectionResults(results, isVideoResult, (row) =>
            row.provider_video_id === result.provider_video_id
              ? { ...row, media_id: added.mediaId }
              : row
          );
        })
      );
      requestOpenInAppPane(`/media/${added.mediaId}`);
    } catch (addError) {
      setError(toFeedback(addError, { fallback: "Failed to add result" }));
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current);
        next.delete(busyKey);
        return next;
      });
    }
  }

  async function loadMore(sectionType: BrowseSectionType) {
    const nextCursor = getSectionPage(sections, sectionType).next_cursor;
    if (!appliedQuery || !nextCursor) {
      return;
    }
    setLoadingMoreTypes((current) => new Set(current).add(sectionType));
    setError(null);
    try {
      const params = new URLSearchParams({
        q: appliedQuery,
        limit: "10",
        page_type: sectionType,
        cursor: nextCursor,
      });
      const response = await apiFetch<BrowseResponse>(`/api/browse?${params.toString()}`);
      setSections((current) =>
        mergeSectionResults(current, sectionType, getSection(normalizeSections(response.data), sectionType))
      );
    } catch (loadMoreError) {
      setError(toFeedback(loadMoreError, { fallback: "Failed to load more results" }));
    } finally {
      setLoadingMoreTypes((current) => {
        const next = new Set(current);
        next.delete(sectionType);
        return next;
      });
    }
  }

  const visibleSections = visibleTypes.filter((type) => getSectionResults(sections, type).length > 0);
  const selectedTypeSet = new Set(visibleTypes);

  return (
    <SectionCard>
      <div className={styles.content}>
        <form
          className={styles.searchForm}
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = draftQuery.trim();
            if (!trimmed) {
              return;
            }
            paneRouter.replace(buildBrowseHref(trimmed, visibleTypes));
          }}
        >
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              type="search"
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Search for new podcasts, episodes, videos, or documents..."
              autoFocus
            />
            <button
              type="submit"
              className={styles.searchBtn}
              disabled={searching || !draftQuery.trim()}
            >
              {searching ? "..." : "Search"}
            </button>
          </div>

          <div className={styles.filters} aria-label="Browse visible result types">
            {BROWSE_TYPES.map((type) => (
              <label key={type} className={styles.filterOption}>
                <input
                  type="checkbox"
                  checked={selectedTypeSet.has(type)}
                  onChange={(event) => {
                    if (event.target.checked) {
                      updateVisibleTypes(
                        [...visibleTypes, type].filter(
                          (value, index, values) => values.indexOf(value) === index
                        )
                      );
                      return;
                    }
                    updateVisibleTypes(visibleTypes.filter((value) => value !== type));
                  }}
                />
                <span>{TYPE_LABELS[type]}</span>
              </label>
            ))}
          </div>
        </form>

        {error ? <FeedbackNotice feedback={error} /> : null}

        {!hasSearched ? (
          <FeedbackNotice severity="info">
            Search once, then filter which result types stay visible. Browse finds things that are not already in your workspace.
          </FeedbackNotice>
        ) : null}

        {searching ? <FeedbackNotice severity="info">Searching...</FeedbackNotice> : null}

        {hasSearched && !searching && visibleSections.length === 0 ? (
          <FeedbackNotice severity="neutral">
            {visibleTypes.length === 0
              ? "Select at least one visible result type."
              : "No browse results found for this query."}
          </FeedbackNotice>
        ) : null}

        {visibleSections.map((sectionType) => (
          <section key={sectionType} className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>{TYPE_LABELS[sectionType]}</h2>
            </div>

            <div className={styles.resultRows}>
              {getSectionResults(sections, sectionType).map((result) => {
                if (result.type === "documents") {
                  const busy = busyKeys.has(`document:${result.url}`);
                  const sourceLabel = getDocumentSourceLabel(result);
                  return (
                    <div key={result.url} className={styles.row}>
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => {
                          void addAndOpenResult(result);
                        }}
                      >
                        <div className={styles.leading}>
                          <span className={styles.fallback} aria-hidden="true">
                            <FileText size={18} />
                          </span>
                        </div>
                        <div className={styles.copy}>
                          <div className={styles.headingRow}>
                            <span className={styles.typeBadge}>
                              {result.document_kind === "pdf"
                                ? "PDF"
                                : result.document_kind === "epub"
                                  ? "EPUB"
                                  : "Article"}
                            </span>
                            {sourceLabel ? (
                              <span className={styles.typeBadge}>{sourceLabel}</span>
                            ) : null}
                          </div>
                          <div className={styles.title}>{result.title}</div>
                          <div className={styles.description}>
                            {result.description || getDocumentFallbackDescription(result)}
                          </div>
                        </div>
                      </button>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.primaryAction}
                          disabled={busy}
                          onClick={() => {
                            void addAndOpenResult(result);
                          }}
                        >
                          {getDocumentActionLabel(result, busy)}
                        </button>
                        {!result.media_id ? (
                          <LibraryTargetPicker
                            label={getDocumentLibraryActionLabel(result)}
                            libraries={libraries}
                            loading={librariesLoading}
                            disabled={busy}
                            onOpen={() => {
                              void loadLibraries();
                            }}
                            onSelectLibrary={(libraryId) => {
                              void addAndOpenResult(result, libraryId);
                            }}
                            emptyMessage="No non-default libraries available."
                          />
                        ) : null}
                      </div>
                    </div>
                  );
                }

                if (result.type === "videos") {
                  const busy = busyKeys.has(`video:${result.provider_video_id}`);
                  return (
                    <div key={result.provider_video_id} className={styles.row}>
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => {
                          void addAndOpenResult(result);
                        }}
                      >
                        <div className={styles.leading}>
                          {result.thumbnail_url ? (
                            <Image
                              src={`/api/media/image?url=${encodeURIComponent(result.thumbnail_url)}`}
                              alt=""
                              width={56}
                              height={56}
                              className={styles.artwork}
                              unoptimized
                            />
                          ) : (
                            <span className={styles.fallback} aria-hidden="true">
                              <Video size={18} />
                            </span>
                          )}
                        </div>
                        <div className={styles.copy}>
                          <div className={styles.headingRow}>
                            <span className={styles.typeBadge}>Video</span>
                            {result.channel_title ? (
                              <span className={styles.meta}>{result.channel_title}</span>
                            ) : null}
                          </div>
                          <div className={styles.title}>{result.title}</div>
                          <div className={styles.description}>
                            {result.description || "Add this video to open it in the media reader."}
                          </div>
                        </div>
                      </button>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.primaryAction}
                          disabled={busy}
                          onClick={() => {
                            void addAndOpenResult(result);
                          }}
                        >
                          {result.media_id ? (busy ? "Opening..." : "Open") : busy ? "Adding..." : "Add"}
                        </button>
                        {!result.media_id ? (
                          <LibraryTargetPicker
                            label="Add + library"
                            libraries={libraries}
                            loading={librariesLoading}
                            disabled={busy}
                            onOpen={() => {
                              void loadLibraries();
                            }}
                            onSelectLibrary={(libraryId) => {
                              void addAndOpenResult(result, libraryId);
                            }}
                            emptyMessage="No non-default libraries available."
                          />
                        ) : null}
                      </div>
                    </div>
                  );
                }

                if (result.type === "podcasts") {
                  const busy = busyKeys.has(`podcast:${result.provider_podcast_id}`);
                  return (
                    <div key={result.provider_podcast_id} className={styles.row}>
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => {
                          void ensureAndOpenPodcast(result);
                        }}
                      >
                        <div className={styles.leading}>
                          {result.image_url ? (
                            <Image
                              src={`/api/media/image?url=${encodeURIComponent(result.image_url)}`}
                              alt=""
                              width={56}
                              height={56}
                              className={styles.artwork}
                              unoptimized
                            />
                          ) : (
                            <span className={styles.fallback} aria-hidden="true">
                              <Mic size={18} />
                            </span>
                          )}
                        </div>
                        <div className={styles.copy}>
                          <div className={styles.headingRow}>
                            <span className={styles.typeBadge}>Podcast</span>
                            {result.author ? <span className={styles.meta}>{result.author}</span> : null}
                          </div>
                          <div className={styles.title}>{result.title}</div>
                          <div className={styles.description}>
                            {result.description || "Open the show page or follow it from browse."}
                          </div>
                        </div>
                      </button>
                      <div className={styles.actions}>
                        {result.podcast_id ? (
                          <button
                            type="button"
                            className={styles.primaryAction}
                            disabled={busy}
                            onClick={() => {
                              void ensureAndOpenPodcast(result);
                            }}
                          >
                            {busy ? "Opening..." : "Open"}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={styles.primaryAction}
                              disabled={busy}
                              onClick={() => {
                                void followPodcast(result);
                              }}
                            >
                              {busy ? "Following..." : "Follow"}
                            </button>
                            <LibraryTargetPicker
                              label="Follow + library"
                              libraries={libraries}
                              loading={librariesLoading}
                              disabled={busy}
                              onOpen={() => {
                                void loadLibraries();
                              }}
                              onSelectLibrary={(libraryId) => {
                                void followPodcast(result, libraryId);
                              }}
                              emptyMessage="No non-default libraries available."
                            />
                          </>
                        )}
                      </div>
                    </div>
                  );
                }

                const busy = busyKeys.has(`podcast:${result.provider_podcast_id}`);
                return (
                  <div key={result.provider_episode_id} className={styles.row}>
                    <button
                      type="button"
                      className={styles.primary}
                      onClick={() => {
                        void ensureAndOpenPodcast(result);
                      }}
                    >
                      <div className={styles.leading}>
                        {result.podcast_image_url ? (
                          <Image
                            src={`/api/media/image?url=${encodeURIComponent(result.podcast_image_url)}`}
                            alt=""
                            width={56}
                            height={56}
                            className={styles.artwork}
                            unoptimized
                          />
                        ) : (
                          <span className={styles.fallback} aria-hidden="true">
                            <Play size={18} />
                          </span>
                        )}
                      </div>
                      <div className={styles.copy}>
                        <div className={styles.headingRow}>
                          <span className={styles.typeBadge}>Episode</span>
                          <span className={styles.meta}>{result.podcast_title}</span>
                        </div>
                        <div className={styles.title}>{result.title}</div>
                        <div className={styles.description}>{formatEpisodeMeta(result)}</div>
                      </div>
                    </button>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.primaryAction}
                        disabled={busy}
                        onClick={() => {
                          void ensureAndOpenPodcast(result);
                        }}
                      >
                        {busy ? "Opening..." : "Open show"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {getSectionPage(sections, sectionType).next_cursor ? (
              <button
                type="button"
                className={styles.loadMore}
                onClick={() => {
                  void loadMore(sectionType);
                }}
                disabled={loadingMoreTypes.has(sectionType)}
              >
                {loadingMoreTypes.has(sectionType)
                  ? "Loading..."
                  : `Load more ${TYPE_LABELS[sectionType].toLowerCase()}`}
              </button>
            ) : null}
          </section>
        ))}
      </div>
    </SectionCard>
  );
}
