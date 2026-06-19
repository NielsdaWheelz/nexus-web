"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import LibraryDestinationPicker from "@/components/LibraryDestinationPicker";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import CollectionView from "@/components/collections/CollectionView";
import CollectionDisplayControls from "@/components/collections/CollectionDisplayControls";
import { presentBrowseResult } from "@/lib/collections/presenters/browse";
import { withCollectionDisplayHref } from "@/lib/collections/collectionViewState";
import { useCollectionDisplayState } from "@/lib/collections/useCollectionDisplayState";
import { apiFetch } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
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
  getDocumentActionLabel,
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
  type BrowseResult,
  type BrowseSectionData,
  type BrowseSectionType,
  type BrowseVideoResult,
} from "./browseState";
import { useOptimisticAction } from "@/lib/ui/useOptimisticAction";
import BrowseTypeFilters from "./BrowseTypeFilters";
import styles from "./page.module.css";

/** Library-selection key for a row that can be added to libraries. */
function rowKeyFor(result: BrowseDocumentResult | BrowseVideoResult | BrowsePodcastResult): string {
  if (result.type === "documents") return `document:${result.url}`;
  if (result.type === "videos") return `video:${result.provider_video_id}`;
  return `podcast:${result.provider_podcast_id}`;
}

export default function BrowsePaneBody() {
  const paneRouter = usePaneRouter();
  const { openInNewPane } = usePaneRuntime() ?? {};
  const paneSearchParams = usePaneSearchParams();
  const { displayState, setDisplayState } = useCollectionDisplayState("/browse");
  const appliedQuery = normalizeBrowseQuery(paneSearchParams.get("q"));
  const visibleTypes = parseVisibleTypes(paneSearchParams);

  const [draftQuery, setDraftQuery] = useState(appliedQuery);
  const [sections, setSections] =
    useState<Record<BrowseSectionType, BrowseSectionData>>(emptySections);
  const [loadingMoreTypes, setLoadingMoreTypes] = useState<
    Set<BrowseSectionType>
  >(new Set());
  const { isBusy, runWithBusy } = useOptimisticAction();
  const [actionError, setActionError] = useState<FeedbackContent | null>(null);
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
  const loadError = useMemo(
    () =>
      browseResource.status === "error"
        ? toFeedback(browseResource.error, { fallback: "Browse failed" })
        : null,
    [browseResource],
  );

  const getRowLibraryIds = useCallback(
    (rowKey: string): string[] => rowLibraryIds[rowKey] ?? [],
    [rowLibraryIds],
  );

  const setRowSelection = useCallback((rowKey: string, next: string[]) => {
    setRowLibraryIds((current) => ({ ...current, [rowKey]: next }));
  }, []);

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
    paneRouter.replace(
      withCollectionDisplayHref(
        buildBrowseHref(appliedQuery, nextVisibleTypes),
        displayState,
      ),
      { viewTransition: { kind: "collection-reflow" } },
    );
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
    await runWithBusy(busyKey, async () => {
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
        if (handleUnauthenticatedApiError(openError)) return;
        setActionError(
          toFeedback(openError, { fallback: "Failed to open podcast" }),
        );
      }
    });
  }

  async function followPodcast(
    result: BrowsePodcastResult,
    libraryIds: string[] = [],
  ) {
    const busyKey = `podcast:${result.provider_podcast_id}`;
    await runWithBusy(busyKey, async () => {
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
        if (handleUnauthenticatedApiError(followError)) return;
        setActionError(
          toFeedback(followError, { fallback: "Failed to follow podcast" }),
        );
      }
    });
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
    await runWithBusy(busyKey, async () => {
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
        if (handleUnauthenticatedApiError(addError)) return;
        setActionError(
          toFeedback(addError, { fallback: "Failed to add result" }),
        );
      }
    });
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
      if (handleUnauthenticatedApiError(loadMoreError)) return;
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

  // Surface-specific activation per section: the presenter emits the primary
  // button; the pane wires it to add/open/follow with the row's chosen libraries.
  const onActivate = useCallback(
    (result: BrowseResult) => {
      if (result.type === "documents" || result.type === "videos") {
        void addAndOpenResult(result, getRowLibraryIds(rowKeyFor(result)));
        return;
      }
      void ensureAndOpenPodcast(result);
    },
    // addAndOpenResult/ensureAndOpenPodcast are stable closures over component state.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: handlers are recreated each render but read live state; the row-library lookup is the only reactive dependency.
    [getRowLibraryIds],
  );

  const activateLabel = useCallback((result: BrowseResult): string => {
    switch (result.type) {
      case "documents":
        return `${getDocumentActionLabel(result, false)} ${result.title}`;
      case "videos":
        return `${result.media_id ? "Open" : "Add"} ${result.title}`;
      case "podcasts":
        return `Open ${result.title}`;
      case "podcast_episodes":
        return `Open show for ${result.title}`;
    }
  }, []);

  // The library-destination picker (and Follow) stay pane-owned controls; the
  // presenter cannot emit them. Keyed by the same id the presenter assigns.
  const controlsFor = useCallback(
    (result: BrowseResult): ReactNode => {
      // Episodes have no add target; already-added rows fall back to the
      // presenter's "Open" primary, so they need no pane-owned control.
      if (result.type === "podcast_episodes") return null;
      if (result.type === "podcasts" ? result.podcast_id : result.media_id) {
        return null;
      }
      const rowKey = rowKeyFor(result);
      const picker = (
        <LibraryDestinationPicker
          selectedLibraryIds={getRowLibraryIds(rowKey)}
          onChange={(next) => setRowSelection(rowKey, next)}
          label="Libraries"
        />
      );
      if (result.type !== "podcasts") return picker;
      const busy = isBusy(rowKey);
      return (
        <>
          {picker}
          <Button
            variant="primary"
            size="md"
            loading={busy}
            disabled={busy}
            onClick={() => {
              void followPodcast(result, getRowLibraryIds(rowKey));
            }}
          >
            Follow
          </Button>
        </>
      );
    },
    // followPodcast reads live state; the reactive inputs are the selection map + busy predicate.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: pane handlers are stable-by-convention; only getRowLibraryIds/setRowSelection/busy participate in reactivity.
    [getRowLibraryIds, setRowSelection, isBusy],
  );

  const visibleSections = visibleTypes.filter(
    (type) => sections[type].results.length > 0,
  );

  const toolbar = (
    <form
      className={styles.searchForm}
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = draftQuery.trim();
        if (!trimmed) {
          return;
        }
        paneRouter.replace(
          withCollectionDisplayHref(buildBrowseHref(trimmed, visibleTypes), displayState),
          { viewTransition: { kind: "collection-reflow" } },
        );
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
      <div className={styles.displayControls}>
        <CollectionDisplayControls
          value={displayState}
          onChange={setDisplayState}
        />
      </div>
    </form>
  );

  const status = loadError ? "error" : searching ? "loading" : "ready";
  const empty =
    visibleSections.length === 0 ? (
      !hasSearched ? (
        <FeedbackNotice severity="info">
          Search once, then filter which result types stay visible. Browse finds
          things that are not already in your workspace.
        </FeedbackNotice>
      ) : (
        <FeedbackNotice severity="neutral">
          {visibleTypes.length === 0
            ? "Select at least one visible result type."
            : "No browse results found for this query."}
        </FeedbackNotice>
      )
    ) : undefined;

  return (
    <div className={styles.pane}>
      <CollectionView
        rows={[]}
        view={displayState.view}
        density={displayState.density}
        status={status}
        ariaLabel="Browse"
        toolbar={toolbar}
        notice={actionError ? <FeedbackNotice feedback={actionError} /> : undefined}
        error={loadError ? <FeedbackNotice feedback={loadError} /> : undefined}
        empty={empty}
      />

      {visibleSections.map((sectionType) => {
        const section = sections[sectionType];
        const rows = section.results.map((result) =>
          presentBrowseResult(result, {
            onActivate,
            activateLabel: activateLabel(result),
          }),
        );
        const rowControls: Record<string, ReactNode> = {};
        section.results.forEach((result, index) => {
          const controls = controlsFor(result);
          if (controls) {
            rowControls[rows[index].id] = controls;
          }
        });
        return (
          <CollectionView
            key={sectionType}
            rows={rows}
            view={displayState.view}
            density={displayState.density}
            status="ready"
            ariaLabel={TYPE_LABELS[sectionType]}
            toolbar={
              <h2 className={styles.sectionHeading}>{TYPE_LABELS[sectionType]}</h2>
            }
            rowControls={rowControls}
            footer={
              <LoadMoreFooter
                hasMore={section.page.next_cursor !== null}
                loading={loadingMoreTypes.has(sectionType)}
                onLoadMore={() => {
                  void loadMore(sectionType);
                }}
                label={`Load more ${TYPE_LABELS[sectionType].toLowerCase()}`}
              />
            }
          />
        );
      })}
    </div>
  );
}
