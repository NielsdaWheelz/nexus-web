"use client";

// A preview shows something outside Nexus without acquiring it: opening,
// playing and leaving write nothing. Only AcquisitionControl acquires. A
// target already in Nexus redirects to its owned pane.

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
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import MediaImage from "@/components/ui/MediaImage";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { ApiError } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import { useCursorPagination } from "@/lib/api/useCursorPagination";
import { useResource } from "@/lib/api/useResource";
import {
  browsePreviewHref,
  fetchBrowsePreview,
  type BrowsePreview,
} from "@/lib/browse/api";
import { BROWSE_SOURCE_LABELS } from "@/lib/browse/query";
import { presentPreviewEpisode } from "@/lib/collections/presenters/browse";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import {
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePlayerCommands } from "@/lib/player/playerRuntime";
import {
  addEpisodeFromDiscovery,
  subscribeToPodcast,
} from "@/lib/podcasts/api";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "../browse.module.css";

interface Failure {
  readonly content: FeedbackContent;
  readonly retryable: boolean;
}

const INVALID: Failure = {
  content: {
    tone: "Warning",
    title: "Invalid preview link",
    message: "This link is malformed or obsolete.",
  },
  retryable: false,
};

/** Retryable or terminal; any other code is a defect. */
function previewErrorMessage(error: ApiError): Failure {
  const failed = (message: string): Failure => ({
    content: {
      tone: "Danger",
      title: "Preview couldn’t be loaded",
      message,
      requestId: error.requestId,
    },
    retryable: true,
  });
  const terminal = (title: string, message?: string): Failure => ({
    content: { tone: "Warning", title, message, requestId: error.requestId },
    retryable: false,
  });
  switch (error.code) {
    case "E_NETWORK":
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      return failed("Check your connection and retry.");
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
      return failed(
        "The discovery provider is unavailable. Retry in a moment.",
      );
    case "E_RATE_LIMITED":
    case "E_BROWSE_PROVIDER_RATE_LIMITED":
      return failed("Wait a moment, then retry.");
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      return terminal(
        "Preview isn’t available",
        "The discovery provider’s allowance has been exhausted.",
      );
    case "E_INVALID_DISCOVERY_TARGET":
      return terminal("Invalid preview link");
    case "E_NOT_FOUND":
      return terminal("No longer available");
    default:
      throw error;
  }
}

function PreviewEpisodes({
  preview,
}: {
  readonly preview: Extract<BrowsePreview, { kind: "Podcast" }>;
}) {
  const pagination = useCursorPagination({
    firstPage: useMemo(
      () => ({ status: "ready" as const, data: preview.episodes }),
      [preview.episodes],
    ),
    initialMoreError: null,
    loadMorePage: async (cursor, signal) => {
      const next = await fetchBrowsePreview(preview.target, cursor, signal);
      if (next.kind !== "Podcast") {
        // justify-defect: a podcast target always previews as a podcast.
        throw new Error("A podcast preview continued as another kind");
      }
      return next.episodes;
    },
  });
  return (
    <PaneSection title="Episodes">
      <CollectionView
        returnScope="Browse.Preview.PodcastEpisodes"
        rows={pagination.items.map(presentPreviewEpisode)}
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
      <LoadMoreFooter
        hasMore={pagination.hasMore}
        loading={pagination.loadingMore}
        onLoadMore={pagination.loadMore}
      />
    </PaneSection>
  );
}

export default function BrowsePreviewPaneBody() {
  const router = usePaneRouter();
  const target = usePaneSearchParams().get("target");
  const resource = useResource<BrowsePreview>({
    cacheKey: target === null ? null : `browse-preview:${target}`,
    // justify-type-assertion: useResource loads only for a non-null cacheKey.
    load: (signal) => fetchBrowsePreview(target as string, null, signal),
  });
  const [videoLoaded, setVideoLoaded] = useState(false);
  const { playPreviewAudio } = usePlayerCommands();
  const preview = resource.status === "ready" ? resource.data : null;
  const owned =
    preview !== null && preview.resolution.kind !== "Preview"
      ? preview.resolution.href
      : null;
  useEffect(() => {
    if (owned !== null) router.replace(owned, { labelHint: preview?.title });
  }, [owned, preview?.title, router]);
  const failure =
    target === null
      ? INVALID
      : resource.status === "error"
        ? previewErrorMessage(resource.error)
        : null;
  useSetPaneLabel(preview?.title ?? null);
  usePanePrimaryChrome({
    header:
      failure !== null
        ? { kind: "Resource", resource: { status: "Failed" } }
        : preview === null
          ? undefined
          : {
              kind: "Resource",
              resource: {
                status: "Ready",
                creditGroups: [
                  {
                    kind: "Role",
                    label: "Source",
                    credits: [
                      {
                        label: BROWSE_SOURCE_LABELS[preview.source],
                        href: preview.sourceHref,
                      },
                    ],
                  },
                ],
              },
            },
  });
  usePaneReturnReady(failure !== null || (preview !== null && owned === null));

  if (failure !== null) {
    const back = () =>
      router.canGoBack ? router.back() : router.replace("/browse");
    return (
      <PaneSurface
        state={
          <FeedbackNotice content={failure.content} announcement="Assertive" />
        }
      >
        {failure.retryable && resource.status === "error" ? (
          <Button onClick={resource.retry}>Retry</Button>
        ) : (
          <Button onClick={back}>Back to Browse</Button>
        )}
      </PaneSurface>
    );
  }
  if (preview === null || owned !== null) {
    return (
      <PaneSurface
        state={
          <PaneLoadingState label="Loading preview…" announcement="Polite" />
        }
      />
    );
  }

  const commit = async (
    command: AcquisitionCommand,
  ): Promise<AcquisitionSuccess> => {
    const { namedLibraryIds, idempotencyKey } = command;
    switch (preview.kind) {
      case "Podcast": {
        const result = await subscribeToPodcast({
          target: { kind: "Discovery", target: preview.target },
          namedLibraryIds,
          replacementConfirmation: command.replacementConfirmation,
        });
        return { href: result.href };
      }
      case "Episode": {
        const { href, mediaId } = await addEpisodeFromDiscovery({
          target: preview.target,
          namedLibraryIds,
        });
        return { href, mediaId };
      }
      default: {
        const url =
          preview.kind === "Epub"
            ? preview.kindFacts.importHref
            : preview.kind === "WebArticle"
              ? preview.kindFacts.canonicalUrl
              : preview.sourceHref;
        const { mediaId } = await addMediaFromUrl({
          url,
          libraryIds: namedLibraryIds,
          idempotencyKey,
        });
        return { href: `/media/${mediaId}`, mediaId };
      }
    }
  };
  const acquisition = (
    <AcquisitionControl
      kind={preview.kind === "Podcast" ? "Subscribe" : "Add"}
      previewTarget={preview.target}
      commit={commit}
      onCommitted={(href) => router.replace(href, { labelHint: preview.title })}
    />
  );
  // justify-type-assertion: the server issues every browse image as a media
  // image proxy src (services/browse/models.py proxied_image).
  const image =
    preview.image.kind === "Present"
      ? (preview.image.value as MediaImageProxySrc)
      : null;
  const description =
    preview.description.kind === "Present" ? preview.description.value : null;

  if (preview.kind === "Podcast") {
    const website = preview.kindFacts.websiteHref;
    return (
      <PaneSurface>
        <PodcastOverview
          title={preview.title}
          image={image ? { kind: "Proxied", url: image } : { kind: "Absent" }}
          contributors={preview.contributors}
          description={description}
          facts={["Podcast Index"]}
          links={[
            { label: "Open source", href: preview.sourceHref },
            { label: "RSS feed", href: preview.kindFacts.feedHref },
            ...(website.kind === "Present"
              ? [{ label: "Website", href: website.value }]
              : []),
          ]}
          note="Previewing does not subscribe or add episodes."
        />
        {acquisition}
        <PreviewEpisodes preview={preview} />
      </PaneSurface>
    );
  }
  const audio = preview.kind === "Episode" ? preview.kindFacts : null;
  const host = audio === null ? null : new URL(audio.audioHref).hostname;
  return (
    <PaneSurface>
      <div className={styles.lead}>
        {image ? (
          <MediaImage
            kind="proxy-src"
            src={image}
            alt=""
            width={128}
            height={128}
            className={styles.image}
          />
        ) : null}
        <div>
          {audio ? <p>{audio.podcastTitle}</p> : null}
          <p>{description ?? "No summary from source."}</p>
          <a
            href={preview.sourceHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open source
          </a>
        </div>
      </div>
      {preview.kind !== "Video" ? null : videoLoaded ? (
        <YouTubeEmbedFrame
          embedUrl={preview.kindFacts.embedHref}
          className={styles.video}
        />
      ) : (
        <Button variant="secondary" onClick={() => setVideoLoaded(true)}>
          Load video
        </Button>
      )}
      {audio !== null && host !== null ? (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            onClick={() =>
              playPreviewAudio({
                target: preview.target,
                previewHref: browsePreviewHref(preview.target),
                title: preview.title,
                source: host,
                sourceHref: preview.sourceHref,
                audioUrl: audio.audioHref,
                imageUrl: image ? present(image) : absent(),
                durationMs:
                  audio.durationSeconds.kind === "Present"
                    ? present(audio.durationSeconds.value * 1000)
                    : absent(),
              })
            }
          >
            Play preview
          </Button>
          <span>Audio from {host}</span>
        </div>
      ) : null}
      {acquisition}
    </PaneSurface>
  );
}
