"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MediaImage from "@/components/ui/MediaImage";
import { FileText, Mic, Play, Video } from "lucide-react";
import LibraryMultiSelectPicker from "@/components/LibraryMultiSelectPicker";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import SectionCard from "@/components/ui/SectionCard";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { apiFetch } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import {
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import {
  subscribeToPodcast,
  toPodcastContributorInputs,
} from "../podcasts/podcastSubscriptions";
import {
  TYPE_LABELS,
  buildBrowseHref,
  emptySections,
  formatEpisodeMeta,
  getDocumentActionLabel,
  getDocumentFallbackDescription,
  getDocumentSourceLabel,
  isDocumentResult,
  isPodcastEpisodeResult,
  isPodcastResult,
  isVideoResult,
  mergeSectionResults,
  normalizeBrowseQuery,
  normalizeSections,
  parseVisibleTypes,
  updateSection,
  updateSectionResults,
  type BrowseDocumentResult,
  type BrowseEpisodeResult,
  type BrowsePodcastResult,
  type BrowseResponse,
  type BrowseSectionData,
  type BrowseSectionType,
  type BrowseVideoResult,
} from "./browseState";
import { useStringIdSet } from "@/lib/useStringIdSet";
import { useNonDefaultLibraries } from "@/lib/media/useNonDefaultLibraries";
import BrowseTypeFilters from "./BrowseTypeFilters";
import styles from "./page.module.css";

export default function BrowsePaneBody() {
  const paneRouter = usePaneRouter();
  const { openInNewPane } = usePaneRuntime() ?? {};
  const paneSearchParams = usePaneSearchParams();
  const appliedQuery = normalizeBrowseQuery(paneSearchParams.get("q"));
  const visibleTypes = parseVisibleTypes(paneSearchParams);

  const [draftQuery, setDraftQuery] = useState(appliedQuery);
  const [sections, setSections] =
    useState<Record<BrowseSectionType, BrowseSectionData>>(emptySections);
  const [loadingMoreTypes, setLoadingMoreTypes] = useState<
    Set<BrowseSectionType>
  >(new Set());
  const busyKeys = useStringIdSet();
  const [actionError, setActionError] = useState<FeedbackContent | null>(null);
  const libraryPicker = useNonDefaultLibraries();
  const [rowLibraryIds, setRowLibraryIds] = useState<Record<string, string[]>>(
    {},
  );
  const browseResource = useResource<BrowseResponse>({
    cacheKey: appliedQuery || null,
    path: (query) => {
      const params = new URLSearchParams({ q: query, limit: "10" });
      return `/api/browse?${params.toString()}`;
    },
  });
  const searching = browseResource.status === "loading";
  const hasSearched = Boolean(appliedQuery);
  const error = useMemo(() => {
    if (actionError) {
      return actionError;
    }
    if (browseResource.status === "error") {
      return toFeedback(browseResource.error, { fallback: "Browse failed" });
    }
    return null;
  }, [actionError, browseResource]);

  const pickerLibraries = useMemo(
    () =>
      libraryPicker.libraries.map((library) => ({
        id: library.id,
        name: library.name,
        color: library.color,
      })),
    [libraryPicker.libraries],
  );

  const getRowLibraryIds = useCallback(
    (rowKey: string): string[] => rowLibraryIds[rowKey] ?? [],
    [rowLibraryIds],
  );

  const setRowSelection = useCallback((rowKey: string, next: string[]) => {
    setRowLibraryIds((current) => ({ ...current, [rowKey]: next }));
  }, []);

  const { load: loadLibraries } = libraryPicker;
  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  useEffect(() => {
    setDraftQuery(appliedQuery);
  }, [appliedQuery]);

  useEffect(() => {
    if (!appliedQuery) {
      setSections(emptySections());
      setActionError(null);
      return;
    }

    setActionError(null);
    if (browseResource.status === "ready") {
      setSections(normalizeSections(browseResource.data.data));
      return;
    }
    if (
      browseResource.status === "loading" ||
      browseResource.status === "error"
    ) {
      setSections(emptySections());
    }
  }, [appliedQuery, browseResource]);

  function updateVisibleTypes(nextVisibleTypes: BrowseSectionType[]) {
    paneRouter.replace(buildBrowseHref(appliedQuery, nextVisibleTypes));
  }

  async function ensureAndOpenPodcast(
    result: BrowsePodcastResult | BrowseEpisodeResult,
  ) {
    const titleHint =
      result.type === "podcasts" ? result.title : result.podcast_title;
    if (result.podcast_id) {
      openInNewPane?.(`/podcasts/${result.podcast_id}`, titleHint);
      return;
    }

    const busyKey = `podcast:${result.provider_podcast_id}`;
    busyKeys.add(busyKey);
    setActionError(null);
    try {
      const response = await apiFetch<{ data: { podcast_id: string } }>(
        "/api/podcasts/ensure",
        {
          method: "POST",
          body: JSON.stringify({
            provider_podcast_id: result.provider_podcast_id,
            title:
              result.type === "podcasts" ? result.title : result.podcast_title,
            contributors: toPodcastContributorInputs(
              result.type === "podcasts"
                ? result.contributors
                : result.podcast_contributors,
            ),
            feed_url: result.feed_url,
            website_url: result.website_url,
            image_url:
              result.type === "podcasts"
                ? result.image_url
                : result.podcast_image_url,
            description: result.description,
          }),
        },
      );
      const podcastId = response.data.podcast_id;
      setSections((current) =>
        updateSection(
          updateSection(current, "podcasts", (results) =>
            updateSectionResults(results, isPodcastResult, (row) =>
              row.provider_podcast_id === result.provider_podcast_id
                ? { ...row, podcast_id: podcastId }
                : row,
            ),
          ),
          "podcast_episodes",
          (results) =>
            updateSectionResults(results, isPodcastEpisodeResult, (row) =>
              row.provider_podcast_id === result.provider_podcast_id
                ? { ...row, podcast_id: podcastId }
                : row,
            ),
          ),
      );
      openInNewPane?.(`/podcasts/${podcastId}`, titleHint);
    } catch (openError) {
      setActionError(
        toFeedback(openError, { fallback: "Failed to open podcast" }),
      );
    } finally {
      busyKeys.remove(busyKey);
    }
  }

  async function followPodcast(
    result: BrowsePodcastResult,
    libraryIds: string[] = [],
  ) {
    const busyKey = `podcast:${result.provider_podcast_id}`;
    busyKeys.add(busyKey);
    setActionError(null);
    try {
      const response = await subscribeToPodcast({
        provider_podcast_id: result.provider_podcast_id,
        title: result.title,
        contributors: result.contributors,
        feed_url: result.feed_url,
        website_url: result.website_url,
        image_url: result.image_url,
        description: result.description,
        library_ids: libraryIds,
      });
      setSections((current) =>
        updateSection(current, "podcasts", (results) =>
          updateSectionResults(results, isPodcastResult, (row) =>
            row.provider_podcast_id === result.provider_podcast_id
              ? { ...row, podcast_id: response.podcast_id }
              : row,
          ),
        ),
      );
    } catch (followError) {
      setActionError(
        toFeedback(followError, { fallback: "Failed to follow podcast" }),
      );
    } finally {
      busyKeys.remove(busyKey);
    }
  }

  async function addAndOpenResult(
    result: BrowseDocumentResult | BrowseVideoResult,
    libraryIds: string[] = [],
  ) {
    if (result.media_id) {
      openInNewPane?.(`/media/${result.media_id}`, result.title);
      return;
    }

    const busyKey =
      result.type === "documents"
        ? `document:${result.url}`
        : `video:${result.provider_video_id}`;
    busyKeys.add(busyKey);
    setActionError(null);
    try {
      const added = await addMediaFromUrl({
        url: result.type === "documents" ? result.url : result.watch_url,
        libraryIds,
      });
      setSections((current) =>
        updateSection(current, result.type, (results) => {
          if (result.type === "documents") {
            return updateSectionResults(results, isDocumentResult, (row) =>
              row.url === result.url
                ? { ...row, media_id: added.mediaId }
                : row,
            );
          }
          return updateSectionResults(results, isVideoResult, (row) =>
            row.provider_video_id === result.provider_video_id
              ? { ...row, media_id: added.mediaId }
              : row,
          );
        }),
      );
      openInNewPane?.(`/media/${added.mediaId}`, result.title);
    } catch (addError) {
      setActionError(
        toFeedback(addError, { fallback: "Failed to add result" }),
      );
    } finally {
      busyKeys.remove(busyKey);
    }
  }

  async function loadMore(sectionType: BrowseSectionType) {
    const nextCursor = sections[sectionType].page.next_cursor;
    if (!appliedQuery || !nextCursor) {
      return;
    }
    setLoadingMoreTypes((current) => new Set(current).add(sectionType));
    setActionError(null);
    try {
      const params = new URLSearchParams({
        q: appliedQuery,
        limit: "10",
        page_type: sectionType,
        cursor: nextCursor,
      });
      const response = await apiFetch<BrowseResponse>(
        `/api/browse?${params.toString()}`,
      );
      setSections((current) =>
        mergeSectionResults(
          current,
          sectionType,
          normalizeSections(response.data)[sectionType],
        ),
      );
    } catch (loadMoreError) {
      setActionError(
        toFeedback(loadMoreError, { fallback: "Failed to load more results" }),
      );
    } finally {
      setLoadingMoreTypes((current) => {
        const next = new Set(current);
        next.delete(sectionType);
        return next;
      });
    }
  }

  const visibleSections = visibleTypes.filter(
    (type) => sections[type].results.length > 0,
  );

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
            <Input
              className={styles.searchInputField}
              size="lg"
              type="search"
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Search for new podcasts, episodes, videos, or documents..."
              autoFocus
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={searching || !draftQuery.trim()}
            >
              {searching ? "..." : "Search"}
            </Button>
          </div>

          <BrowseTypeFilters visibleTypes={visibleTypes} onChange={updateVisibleTypes} />
        </form>

        {error ? <FeedbackNotice feedback={error} /> : null}

        {!hasSearched ? (
          <FeedbackNotice severity="info">
            Search once, then filter which result types stay visible. Browse
            finds things that are not already in your workspace.
          </FeedbackNotice>
        ) : null}

        {searching ? <PaneLoadingState /> : null}

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
              <h2 className={styles.sectionTitle}>
                {TYPE_LABELS[sectionType]}
              </h2>
            </div>

            <div className={styles.resultRows}>
              {sections[sectionType].results.map((result) => {
                if (result.type === "documents") {
                  const busy = busyKeys.ids.has(`document:${result.url}`);
                  const sourceLabel = getDocumentSourceLabel(result);
                  const rowKey = `document:${result.url}`;
                  const selectedLibraryIds = getRowLibraryIds(rowKey);
                  return (
                    <div key={result.url} className={styles.row}>
                      <div
                        role="button"
                        tabIndex={0}
                        className={styles.primary}
                        onClick={() => {
                          void addAndOpenResult(result, selectedLibraryIds);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }
                          event.preventDefault();
                          void addAndOpenResult(result, selectedLibraryIds);
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
                              <span className={styles.typeBadge}>
                                {sourceLabel}
                              </span>
                            ) : null}
                          </div>
                          <div className={styles.title}>{result.title}</div>
                          <div className={styles.description}>
                            {result.description ||
                              getDocumentFallbackDescription(result)}
                          </div>
                        </div>
                      </div>
                      <ContributorCreditList
                        credits={result.contributors}
                        className={styles.rowContributors}
                        maxVisible={2}
                      />
                      <div className={styles.actions}>
                        {!result.media_id ? (
                          <LibraryMultiSelectPicker
                            mode="dropdown"
                            selectedLibraryIds={selectedLibraryIds}
                            onChange={(next) => setRowSelection(rowKey, next)}
                            libraries={pickerLibraries}
                          />
                        ) : null}
                        <Button
                          variant="primary"
                          size="md"
                          disabled={busy}
                          onClick={() => {
                            void addAndOpenResult(result, selectedLibraryIds);
                          }}
                        >
                          {getDocumentActionLabel(result, busy)}
                        </Button>
                      </div>
                    </div>
                  );
                }

                if (result.type === "videos") {
                  const busy = busyKeys.ids.has(
                    `video:${result.provider_video_id}`,
                  );
                  const rowKey = `video:${result.provider_video_id}`;
                  const selectedLibraryIds = getRowLibraryIds(rowKey);
                  return (
                    <div key={result.provider_video_id} className={styles.row}>
                      <div
                        role="button"
                        tabIndex={0}
                        className={styles.primary}
                        onClick={() => {
                          void addAndOpenResult(result, selectedLibraryIds);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }
                          event.preventDefault();
                          void addAndOpenResult(result, selectedLibraryIds);
                        }}
                      >
                        <div className={styles.leading}>
                          {result.thumbnail_url ? (
                            <MediaImage
                              kind="proxied"
                              remoteUrl={result.thumbnail_url}
                              alt=""
                              width={56}
                              height={56}
                              className={styles.artwork}
                            />
                          ) : (
                            <span
                              className={styles.fallback}
                              aria-hidden="true"
                            >
                              <Video size={18} />
                            </span>
                          )}
                        </div>
                        <div className={styles.copy}>
                          <div className={styles.headingRow}>
                            <span className={styles.typeBadge}>Video</span>
                          </div>
                          <div className={styles.title}>{result.title}</div>
                          <div className={styles.description}>
                            {result.description ||
                              "Add this video to open it in the media reader."}
                          </div>
                        </div>
                      </div>
                      <ContributorCreditList
                        credits={result.contributors}
                        className={styles.rowContributors}
                        maxVisible={2}
                      />
                      <div className={styles.actions}>
                        {!result.media_id ? (
                          <LibraryMultiSelectPicker
                            mode="dropdown"
                            selectedLibraryIds={selectedLibraryIds}
                            onChange={(next) => setRowSelection(rowKey, next)}
                            libraries={pickerLibraries}
                          />
                        ) : null}
                        <Button
                          variant="primary"
                          size="md"
                          disabled={busy}
                          onClick={() => {
                            void addAndOpenResult(result, selectedLibraryIds);
                          }}
                        >
                          {result.media_id
                            ? busy
                              ? "Opening..."
                              : "Open"
                            : busy
                              ? "Adding..."
                              : "Add"}
                        </Button>
                      </div>
                    </div>
                  );
                }

                if (result.type === "podcasts") {
                  const busy = busyKeys.ids.has(
                    `podcast:${result.provider_podcast_id}`,
                  );
                  const rowKey = `podcast:${result.provider_podcast_id}`;
                  const selectedLibraryIds = getRowLibraryIds(rowKey);
                  return (
                    <div
                      key={result.provider_podcast_id}
                      className={styles.row}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        className={styles.primary}
                        onClick={() => {
                          void ensureAndOpenPodcast(result);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }
                          event.preventDefault();
                          void ensureAndOpenPodcast(result);
                        }}
                      >
                        <div className={styles.leading}>
                          {result.image_url ? (
                            <MediaImage
                              kind="proxied"
                              remoteUrl={result.image_url}
                              alt=""
                              width={56}
                              height={56}
                              className={styles.artwork}
                            />
                          ) : (
                            <span
                              className={styles.fallback}
                              aria-hidden="true"
                            >
                              <Mic size={18} />
                            </span>
                          )}
                        </div>
                        <div className={styles.copy}>
                          <div className={styles.headingRow}>
                            <span className={styles.typeBadge}>Podcast</span>
                          </div>
                          <div className={styles.title}>{result.title}</div>
                          <div className={styles.description}>
                            {result.description ||
                              "Open the show page or follow it from browse."}
                          </div>
                        </div>
                      </div>
                      <ContributorCreditList
                        credits={result.contributors}
                        className={styles.rowContributors}
                        maxVisible={2}
                      />
                      <div className={styles.actions}>
                        {result.podcast_id ? (
                          <Button
                            variant="primary"
                            size="md"
                            disabled={busy}
                            onClick={() => {
                              void ensureAndOpenPodcast(result);
                            }}
                          >
                            {busy ? "Opening..." : "Open"}
                          </Button>
                        ) : (
                          <>
                            <LibraryMultiSelectPicker
                              mode="dropdown"
                              selectedLibraryIds={selectedLibraryIds}
                              onChange={(next) =>
                                setRowSelection(rowKey, next)
                              }
                              libraries={pickerLibraries}
                            />
                            <Button
                              variant="primary"
                              size="md"
                              disabled={busy}
                              onClick={() => {
                                void followPodcast(result, selectedLibraryIds);
                              }}
                            >
                              {busy ? "Following..." : "Follow"}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                }

                const busy = busyKeys.ids.has(
                  `podcast:${result.provider_podcast_id}`,
                );
                return (
                  <div key={result.provider_episode_id} className={styles.row}>
                    <div
                      role="button"
                      tabIndex={0}
                      className={styles.primary}
                      onClick={() => {
                        void ensureAndOpenPodcast(result);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") {
                          return;
                        }
                        event.preventDefault();
                        void ensureAndOpenPodcast(result);
                      }}
                    >
                      <div className={styles.leading}>
                        {result.podcast_image_url ? (
                          <MediaImage
                            kind="proxied"
                            remoteUrl={result.podcast_image_url}
                            alt=""
                            width={56}
                            height={56}
                            className={styles.artwork}
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
                          <span className={styles.meta}>
                            {result.podcast_title}
                          </span>
                        </div>
                        <div className={styles.title}>{result.title}</div>
                        <div className={styles.description}>
                          {formatEpisodeMeta(result)}
                        </div>
                      </div>
                    </div>
                    <ContributorCreditList
                      credits={result.podcast_contributors}
                      className={styles.rowContributors}
                      maxVisible={2}
                    />
                    <div className={styles.actions}>
                      <Button
                        variant="primary"
                        size="md"
                        disabled={busy}
                        onClick={() => {
                          void ensureAndOpenPodcast(result);
                        }}
                      >
                        {busy ? "Opening..." : "Open show"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            {sections[sectionType].page.next_cursor ? (
              <Button
                variant="secondary"
                size="md"
                className={styles.loadMore}
                onClick={() => {
                  void loadMore(sectionType);
                }}
                disabled={loadingMoreTypes.has(sectionType)}
              >
                {loadingMoreTypes.has(sectionType)
                  ? "Loading..."
                  : `Load more ${TYPE_LABELS[sectionType].toLowerCase()}`}
              </Button>
            ) : null}
          </section>
        ))}
      </div>
    </SectionCard>
  );
}
