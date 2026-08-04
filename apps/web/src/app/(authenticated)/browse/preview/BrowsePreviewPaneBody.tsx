"use client";

import { useEffect, useMemo, useState } from "react";
import AcquisitionControl, {
  type AcquisitionCommand,
  type AcquisitionSuccess,
} from "@/components/browse/AcquisitionControl";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import YouTubeEmbedFrame from "@/components/media/YouTubeEmbedFrame";
import PodcastOverview from "@/components/podcasts/PodcastOverview";
import Button from "@/components/ui/Button";
import MediaImage from "@/components/ui/MediaImage";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { CursorPage } from "@/lib/api/useCursorPagination";
import { useCursorPagination } from "@/lib/api/useCursorPagination";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import {
  addEpisodeFromDiscovery,
  browsePreviewPath,
  fetchBrowsePreview,
  fetchBrowsePreviewPath,
} from "@/lib/browse/client";
import {
  browsePreviewHref,
  type BrowsePreview,
  type DiscoveryTargetHandle,
  type PreviewEpisodeItem,
  type PreviewEpisodePage,
} from "@/lib/browse/contract";
import { decodeBrowsePreviewQuery } from "@/lib/browse/query";
import { presentPreviewEpisode } from "@/lib/collections/presenters/browse";
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import {
  usePaneReturnReady,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePlayerCommands } from "@/lib/player/globalPlayer";
import { subscribeToPodcast } from "@/lib/podcasts/acquisition";
import styles from "../browse.module.css";

const PREVIEW_EPISODE_PAGE_SIZE = 20;

type BrowsePreviewFailure = {
  content: FeedbackContent;
  retryable: boolean;
};

function browsePreviewErrorMessage(error: unknown): BrowsePreviewFailure {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  switch (error.code) {
    case "E_NETWORK":
      return {
        content: {
          tone: "Danger",
          title: "Preview couldn’t be loaded",
          message: "Check your connection and retry.",
          requestId,
        },
        retryable: true,
      };
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
      return {
        content: {
          tone: "Danger",
          title: "Preview couldn’t be loaded",
          message: "The discovery provider is unavailable. Retry in a moment.",
          requestId,
        },
        retryable: true,
      };
    case "E_BROWSE_PROVIDER_RATE_LIMITED":
      return {
        content: {
          tone: "Warning",
          title: "Preview couldn’t be loaded",
          message: "Wait a moment, then retry.",
          requestId,
        },
        retryable: true,
      };
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      return {
        content: {
          tone: "Warning",
          title: "Preview isn’t available",
          message: "The discovery provider’s allowance has been exhausted.",
          requestId,
        },
        retryable: false,
      };
    case "E_INVALID_DISCOVERY_TARGET":
      return {
        content: { tone: "Warning", title: "Invalid preview link", requestId },
        retryable: false,
      };
    case "E_NOT_FOUND":
      return {
        content: { tone: "Warning", title: "No longer available", requestId },
        retryable: false,
      };
    default:
      throw error;
  }
}

function episodeCursorPage(
  page: PreviewEpisodePage,
): CursorPage<PreviewEpisodeItem> {
  const nextCursor =
    page.nextCursor.kind === "Present" ? page.nextCursor.value : null;
  return {
    data: [...page.items],
    page: {
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
    },
  };
}

function PodcastEpisodePreviewList({
  preview,
}: {
  readonly preview: Extract<BrowsePreview, { kind: "Podcast" }>;
}) {
  const firstPage: AsyncResource<CursorPage<PreviewEpisodeItem>> = useMemo(
    () => ({ status: "ready", data: episodeCursorPage(preview.episodes) }),
    [preview.episodes],
  );
  const pagination = useCursorPagination({
    firstPage,
    initialMoreError: null,
    buildMoreHref: (cursor) =>
      browsePreviewPath({
        target: preview.target,
        limit: PREVIEW_EPISODE_PAGE_SIZE,
        cursor,
      }),
    loadMorePage: async (href, signal) => {
      const next = await fetchBrowsePreviewPath(
        href as `/api/${string}`,
        preview.target,
        signal,
      );
      if (next.kind !== "Podcast") {
        throw new TypeError("Podcast Preview continuation changed identity");
      }
      return episodeCursorPage(next.episodes);
    },
  });
  const rows = useMemo(
    () => pagination.items.map(presentPreviewEpisode),
    [pagination.items],
  );
  return (
    <PaneSection title="Episodes">
      <CollectionView
        returnScope="Browse.Preview.PodcastEpisodes"
        rows={rows}
        status="ready"
        ariaLabel="Podcast episodes"
        empty={<p className={styles.statusRow}>No episodes available</p>}
        surface={false}
        rowActionsAvailable={false}
      />
      {pagination.error ? (
        <div className={styles.statusRow}>
          <span>Couldn’t load more episodes.</span>
          <Button size="sm" variant="secondary" onClick={pagination.retry}>
            Retry
          </Button>
        </div>
      ) : null}
      {pagination.hasMore ? (
        <div className={styles.continuation}>
          <Button
            size="sm"
            variant="secondary"
            loading={pagination.loadingMore}
            onClick={pagination.loadMore}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </PaneSection>
  );
}

function sourceUrlForAdd(
  preview: Extract<
    BrowsePreview,
    { kind: "Epub" | "WebArticle" | "Video" }
  >,
): string {
  switch (preview.kind) {
    case "Epub":
      return preview.kindFacts.importHref;
    case "WebArticle":
      return preview.kindFacts.canonicalUrl;
    case "Video":
      return preview.sourceHref;
  }
}

export default function BrowsePreviewPaneBody() {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const decoded = useMemo(() => decodeBrowsePreviewQuery(params), [params]);
  const target = decoded.kind === "Valid" ? decoded.target : null;
  const resource = useResource<BrowsePreview>({
    cacheKey: target,
    load: (signal) => {
      // justify-type-assertion: useResource never invokes load when cacheKey is
      // null, so this closure runs only for a successfully decoded target.
      const activeTarget = target as DiscoveryTargetHandle;
      return fetchBrowsePreview({
        target: activeTarget,
        limit: PREVIEW_EPISODE_PAGE_SIZE,
        signal,
      });
    },
  });
  const [loadVideo, setLoadVideo] = useState(false);
  const { playPreviewAudio } = usePlayerCommands();
  const preview = resource.status === "ready" ? resource.data : null;
  const ownedHref =
    preview?.resolution.kind === "InNexus"
      ? preview.resolution.href
      : null;
  const backToBrowse = () => {
    if (router.canGoBack) {
      router.back();
      return;
    }
    router.replace("/browse");
  };

  useEffect(() => {
    if (ownedHref) router.replace(ownedHref, { labelHint: preview?.title });
  }, [ownedHref, preview?.title, router]);

  useSetPaneLabel(preview?.title ?? null);
  usePanePrimaryChrome({
    header:
      decoded.kind === "Invalid" || resource.status === "error"
        ? { kind: "Resource", resource: { status: "Failed" } }
        : preview
          ? {
              kind: "Resource",
              resource: {
                status: "Ready",
                creditGroups: [
                  {
                    kind: "Role",
                    label: "Source",
                    credits: [
                      {
                        label:
                          preview.source === "ProjectGutenberg"
                            ? "Project Gutenberg"
                            : preview.source === "PodcastIndex"
                              ? "Podcast Index"
                              : preview.source,
                        href: preview.sourceHref,
                      },
                    ],
                  },
                ],
              },
            }
          : undefined,
  });
  usePaneReturnReady(
    decoded.kind === "Invalid" ||
      resource.status === "error" ||
      (resource.status === "ready" && ownedHref === null),
  );

  if (decoded.kind === "Invalid") {
    return (
      <PaneSurface
        state={
          <FeedbackNotice
            content={{
              tone: "Warning",
              title: "Invalid preview link",
              message: "This link is malformed or obsolete.",
            }}
            announcement="Assertive"
          />
        }
      >
        <Button onClick={backToBrowse}>Back to Browse</Button>
      </PaneSurface>
    );
  }

  if (resource.status === "idle" || resource.status === "loading" || ownedHref) {
    return (
      <PaneSurface
        state={<PaneLoadingState label="Loading preview…" announcement="Polite" />}
      />
    );
  }

  if (resource.status === "error") {
    const failure = browsePreviewErrorMessage(resource.error);
    return (
      <PaneSurface
        state={
          <FeedbackNotice
            content={failure.content}
            announcement="Assertive"
          />
        }
      >
        {failure.retryable ? (
          <Button onClick={resource.retry}>Retry</Button>
        ) : (
          <Button onClick={backToBrowse}>Back to Browse</Button>
        )}
      </PaneSurface>
    );
  }

  const commit = async (
    command: AcquisitionCommand,
  ): Promise<AcquisitionSuccess> => {
    switch (resource.data.kind) {
      case "Podcast": {
        const result = await subscribeToPodcast({
          target: {
            kind: "Discovery",
            target: resource.data.target,
          },
          namedLibraryIds: command.namedLibraryIds,
          replacementConfirmation: command.replacementConfirmation,
          idempotencyKey: command.idempotencyKey,
        });
        return { href: result.href };
      }
      case "Episode": {
        const result = await addEpisodeFromDiscovery({
          target: resource.data.target,
          namedLibraryIds: command.namedLibraryIds,
          idempotencyKey: command.idempotencyKey,
        });
        return { href: result.href, mediaId: result.mediaId };
      }
      case "Epub":
      case "WebArticle":
      case "Video": {
        const result = await addMediaFromUrl({
          url: sourceUrlForAdd(resource.data),
          libraryIds: command.namedLibraryIds,
          idempotencyKey: command.idempotencyKey,
        });
        return {
          href: `/media/${result.mediaId}`,
          mediaId: result.mediaId,
        };
      }
    }
  };

  const description =
    resource.data.description.kind === "Present"
      ? resource.data.description.value
      : null;
  const image =
    resource.data.image.kind === "Present"
      ? resource.data.image.value
      : null;
  const episode =
    resource.data.kind === "Episode" ? resource.data : null;
  const acquisition = (
    <AcquisitionControl
      kind={resource.data.kind === "Podcast" ? "Subscribe" : "Add"}
      previewTarget={resource.data.target}
      commit={commit}
      onCommitted={(href) =>
        router.replace(href, { labelHint: resource.data.title })
      }
    />
  );

  return (
    <PaneSurface>
      {resource.data.kind === "Podcast" ? (
        <>
          <PodcastOverview
            title={resource.data.title}
            image={
              image
                ? { kind: "Proxied", url: image }
                : { kind: "Absent" }
            }
            contributors={resource.data.contributors}
            description={description}
            facts={["Podcast Index"]}
            links={[
              { label: "Open source", href: resource.data.sourceHref },
              { label: "RSS feed", href: resource.data.kindFacts.feedHref },
              ...(resource.data.kindFacts.websiteHref.kind === "Present"
                ? [
                    {
                      label: "Website",
                      href: resource.data.kindFacts.websiteHref.value,
                    },
                  ]
                : []),
            ]}
            note="Previewing does not subscribe or add episodes."
          />
          {acquisition}
          <PodcastEpisodePreviewList preview={resource.data} />
        </>
      ) : (
        <>
          <div className={styles.previewLead}>
            {image ? (
              <MediaImage
                kind="proxy-src"
                src={image}
                alt=""
                width={128}
                height={128}
                className={styles.previewImage}
              />
            ) : null}
            <div className={styles.previewCopy}>
              {resource.data.kind === "Episode" ? (
                <p>{resource.data.kindFacts.podcastTitle}</p>
              ) : null}
              <p>{description ?? "No summary from source."}</p>
              <a
                href={resource.data.sourceHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open source
              </a>
            </div>
          </div>
          {resource.data.kind === "Video" ? (
            loadVideo ? (
              <YouTubeEmbedFrame
                embedUrl={resource.data.kindFacts.embedHref}
                className={styles.videoFrame}
              />
            ) : (
              <Button variant="secondary" onClick={() => setLoadVideo(true)}>
                Load video
              </Button>
            )
          ) : null}
          {episode ? (
            <div className={styles.actions}>
              <Button
                variant="secondary"
                onClick={() =>
                  playPreviewAudio({
                    target: episode.target,
                    previewHref: browsePreviewHref(episode.target),
                    title: episode.title,
                    source: new URL(
                      episode.kindFacts.audioHref,
                    ).hostname,
                    sourceHref: episode.sourceHref,
                    audioUrl: episode.kindFacts.audioHref,
                    imageUrl: episode.image,
                    durationMs:
                      episode.kindFacts.durationSeconds.kind === "Present"
                        ? {
                            kind: "Present",
                            value:
                              episode.kindFacts.durationSeconds.value * 1000,
                          }
                        : { kind: "Absent" },
                  })
                }
              >
                Play preview
              </Button>
              <span>
                Audio from{" "}
                {new URL(episode.kindFacts.audioHref).hostname}
              </span>
            </div>
          ) : null}
          {acquisition}
        </>
      )}
    </PaneSurface>
  );
}
