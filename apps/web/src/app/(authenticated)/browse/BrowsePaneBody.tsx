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
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import SectionCard from "@/components/ui/SectionCard";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { apiFetch } from "@/lib/api/client";
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  subscribeToPodcast,
  toPodcastContributorInputs,
} from "../podcasts/podcastSubscriptions";
import {
  BROWSE_TYPES,
  TYPE_LABELS,
  buildBrowseHref,
  emptySections,
  formatEpisodeMeta,
  getDocumentActionLabel,
  getDocumentFallbackDescription,
  getDocumentLibraryActionLabel,
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
import styles from "./page.module.css";

type LibrarySummary = {
  id: string;
  name: string;
  is_default: boolean;
  color?: string | null;
};

export default function BrowsePaneBody() {
  const paneRouter = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();
  const appliedQuery = normalizeBrowseQuery(paneSearchParams.get("q"));
  const visibleTypes = parseVisibleTypes(paneSearchParams);

  const [draftQuery, setDraftQuery] = useState(appliedQuery);
  const [sections, setSections] =
    useState<Record<BrowseSectionType, BrowseSectionData>>(emptySections);
  const [searching, setSearching] = useState(false);
  const [loadingMoreTypes, setLoadingMoreTypes] = useState<
    Set<BrowseSectionType>
  >(new Set());
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
        const response = await apiFetch<BrowseResponse>(
          `/api/browse?${params.toString()}`,
        );
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
      const response = await apiFetch<{ data: LibrarySummary[] }>(
        "/api/libraries",
      );
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
          })),
      );
      setLibrariesLoaded(true);
    } finally {
      setLibrariesLoading(false);
    }
  }

  function updateVisibleTypes(nextVisibleTypes: BrowseSectionType[]) {
    paneRouter.replace(buildBrowseHref(appliedQuery, nextVisibleTypes));
  }

  async function ensureAndOpenPodcast(
    result: BrowsePodcastResult | BrowseEpisodeResult,
  ) {
    if (result.podcast_id) {
      requestOpenInAppPane(`/podcasts/${result.podcast_id}`);
      return;
    }

    const busyKey = `podcast:${result.provider_podcast_id}`;
    setBusyKeys((current) => new Set(current).add(busyKey));
    setError(null);
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

  async function followPodcast(
    result: BrowsePodcastResult,
    libraryId: string | null = null,
  ) {
    const busyKey = `podcast:${result.provider_podcast_id}`;
    setBusyKeys((current) => new Set(current).add(busyKey));
    setError(null);
    try {
      const response = await subscribeToPodcast({
        provider_podcast_id: result.provider_podcast_id,
        title: result.title,
        contributors: result.contributors,
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
              : row,
          ),
        ),
      );
    } catch (followError) {
      setError(
        toFeedback(followError, { fallback: "Failed to follow podcast" }),
      );
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
    libraryId: string | null = null,
  ) {
    if (result.media_id) {
      requestOpenInAppPane(`/media/${result.media_id}`);
      return;
    }

    const busyKey =
      result.type === "documents"
        ? `document:${result.url}`
        : `video:${result.provider_video_id}`;
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
    const nextCursor = sections[sectionType].page.next_cursor;
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
      setError(
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

          <div
            className={styles.filters}
            aria-label="Browse visible result types"
          >
            {BROWSE_TYPES.map((type) => (
              <label key={type} className={styles.filterOption}>
                <input
                  type="checkbox"
                  checked={selectedTypeSet.has(type)}
                  onChange={(event) => {
                    if (event.target.checked) {
                      updateVisibleTypes(
                        [...visibleTypes, type].filter(
                          (value, index, values) =>
                            values.indexOf(value) === index,
                        ),
                      );
                      return;
                    }
                    updateVisibleTypes(
                      visibleTypes.filter((value) => value !== type),
                    );
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
            Search once, then filter which result types stay visible. Browse
            finds things that are not already in your workspace.
          </FeedbackNotice>
        ) : null}

        {searching ? (
          <FeedbackNotice severity="info">Searching...</FeedbackNotice>
        ) : null}

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
                  const busy = busyKeys.has(`document:${result.url}`);
                  const sourceLabel = getDocumentSourceLabel(result);
                  return (
                    <div key={result.url} className={styles.row}>
                      <div
                        role="button"
                        tabIndex={0}
                        className={styles.primary}
                        onClick={() => {
                          void addAndOpenResult(result);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }
                          event.preventDefault();
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
                        <Button
                          variant="primary"
                          size="md"
                          disabled={busy}
                          onClick={() => {
                            void addAndOpenResult(result);
                          }}
                        >
                          {getDocumentActionLabel(result, busy)}
                        </Button>
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
                  const busy = busyKeys.has(
                    `video:${result.provider_video_id}`,
                  );
                  return (
                    <div key={result.provider_video_id} className={styles.row}>
                      <div
                        role="button"
                        tabIndex={0}
                        className={styles.primary}
                        onClick={() => {
                          void addAndOpenResult(result);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }
                          event.preventDefault();
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
                        <Button
                          variant="primary"
                          size="md"
                          disabled={busy}
                          onClick={() => {
                            void addAndOpenResult(result);
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
                  const busy = busyKeys.has(
                    `podcast:${result.provider_podcast_id}`,
                  );
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
                            <Image
                              src={`/api/media/image?url=${encodeURIComponent(result.image_url)}`}
                              alt=""
                              width={56}
                              height={56}
                              className={styles.artwork}
                              unoptimized
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
                            <Button
                              variant="primary"
                              size="md"
                              disabled={busy}
                              onClick={() => {
                                void followPodcast(result);
                              }}
                            >
                              {busy ? "Following..." : "Follow"}
                            </Button>
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

                const busy = busyKeys.has(
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
