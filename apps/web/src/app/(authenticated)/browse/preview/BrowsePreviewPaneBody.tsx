"use client";

// A preview shows something outside Nexus without acquiring it: opening,
// playing and leaving write nothing. Media actions retain admission intent. A
// target already in Nexus redirects to its owned pane.

import { useEffect, useState } from "react";
import AcquisitionControl, {
  type AcquisitionCommand,
  type AcquisitionSuccess,
} from "@/components/browse/AcquisitionControl";
import MediaActions from "@/components/media/MediaActions";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
  FeedbackStatus,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import YouTubeEmbedFrame from "@/components/media/YouTubeEmbedFrame";
import PodcastOverview from "@/components/podcasts/PodcastOverview";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import MediaImage from "@/components/ui/MediaImage";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import {
  fetchBrowsePreview,
  type BrowsePreview,
} from "@/lib/browse/api";
import { BROWSE_SOURCE_LABELS } from "@/lib/browse/query";
import { presentPreviewEpisode } from "@/lib/collections/presenters/browse";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import {
  usePaneRouter,
  requirePaneRuntime,
  usePaneRuntime,
  usePaneSearchParams,
  usePreviewTitleHint,
} from "@/lib/panes/paneRuntime";
import {
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

/** The preview carries the first page; Load more continues from its cursor. */
function PreviewEpisodes({
  preview,
}: {
  readonly preview: Extract<BrowsePreview, { kind: "Podcast" }>;
}) {
  const first = preview.episodes;
  const list = usePaneFreeServerList<(typeof first.items)[number]>({
    key: `browse-preview-episodes:${preview.target}`,
    stale: "",
    pageSize: 20,
    drain: false,
    active: true,
    id: (episode) => episode.target,
    fetchPage: async (cursor, _limit, signal) => {
      if (cursor === null) return first;
      const next = await fetchBrowsePreview(preview.target, cursor, signal);
      if (next.kind !== "Podcast") {
        // justify-defect: a podcast target always previews as a podcast.
        throw new Error("A podcast preview continued as another kind");
      }
      return next.episodes;
    },
  });
  // Until the list takes up the first page, it is the preview's own.
  const items = list.current ? list.items : first.items;
  return (
    <PaneSection title="Episodes">
      <CollectionView
        returnScope="Browse.Preview.PodcastEpisodes"
        rows={items.map(presentPreviewEpisode)}
        status="ready"
        ariaLabel="Podcast episodes"
        empty={<FeedbackStatus content={{ tone: "Neutral", title: "no episodes available" }} announcement="None" />}
        surface={false}
        rowActionsAvailable={false}
      />
      {list.failure ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "more episodes couldn’t load", requestId: list.failure.error.requestId }}
          announcement="Polite"
          actions={[{ label: "retry", onClick: list.retry, busy: list.running !== null }]}
        />
      ) : null}
      <LoadMoreFooter
        hasMore={list.current ? !list.complete : first.next_cursor !== null}
        loading={list.running === "More"}
        onLoadMore={list.more}
      />
    </PaneSection>
  );
}

export default function BrowsePreviewPaneBody() {
  const pane = requirePaneRuntime(usePaneRuntime(), "BrowsePreviewPaneBody");
  const router = usePaneRouter();
  const target = usePaneSearchParams().get("target");
  const resource = usePaneFreeServerValue<BrowsePreview>({
    key: target === null ? null : `browse-preview:${target}`,
    stale: "",
    // justify-type-assertion: the read runs only for a non-null key.
    load: (signal) => fetchBrowsePreview(target as string, null, signal),
  });
  const [videoLoaded, setVideoLoaded] = useState(false);
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
      : resource.status === "failed"
        ? previewErrorMessage(resource.error)
        : null;
  usePreviewTitleHint(target, preview?.title);
  usePaneChrome({
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
                        href: preview.source_href,
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
          <FeedbackNotice
            content={failure.content}
            announcement="Assertive"
            actions={failure.retryable && resource.status === "failed"
              ? [{ label: "retry", onClick: resource.refetch, busy: resource.retrying }]
              : [{ label: "back to browse", onClick: back }]}
          />
        }
      />
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
    if (preview.kind !== "Podcast") throw new Error("only podcast subscriptions use acquisition controls");
    const result = await subscribeToPodcast({ target: { kind: "Discovery", target: preview.target }, namedLibraryIds: command.namedLibraryIds, replaceEpisodes: command.replaceEpisodes });
    return { href: result.href };
  };
  const acquisition = preview.kind === "Podcast" ? (
    <AcquisitionControl
      key={preview.target}
      scopeKey={preview.target}
      commit={commit}
      openAfterCommit={{ originPaneId: pane.paneId, labelHint: preview.title }}
    />
  ) : null;
  // justify-type-assertion: the server issues every browse image as a media
  // image proxy src (services/browse/models.py proxied_image).
  const image =
    preview.image !== null
      ? (preview.image as MediaImageProxySrc)
      : null;
  const description = preview.description;

  if (preview.kind === "Podcast") {
    const website = preview.kind_facts.website_href;
    return (
      <PaneSurface>
        <PodcastOverview
          title={preview.title}
          image={image ? { kind: "Proxied", url: image } : { kind: "Absent" }}
          contributors={preview.contributors}
          description={description}
          facts={["Podcast Index"]}
          links={[
            { label: "Open source", href: preview.source_href },
            { label: "RSS feed", href: preview.kind_facts.feed_href },
            ...(website !== null
              ? [{ label: "Website", href: website }]
              : []),
          ]}
          note="Previewing does not subscribe or add episodes."
        />
        {acquisition}
        <PreviewEpisodes preview={preview} />
      </PaneSurface>
    );
  }
  const audio = preview.kind === "Episode" ? preview.kind_facts : null;
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
          {audio ? <p>{audio.podcast_title}</p> : null}
          <p>{description ?? "No summary from source."}</p>
          <a
            href={preview.source_href}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open source
          </a>
        </div>
      </div>
      {preview.kind !== "Video" ? null : videoLoaded ? (
        <YouTubeEmbedFrame
          embedUrl={preview.kind_facts.embed_href}
          className={styles.video}
        />
      ) : (
        <Button variant="secondary" onClick={() => setVideoLoaded(true)}>
          Load video
        </Button>
      )}
      <MediaActions
        subject={{
          kind: "External",
          target: preview.target,
          media_kind: preview.kind === "Episode" ? "podcast_episode"
            : preview.kind === "Epub" ? "epub"
            : preview.kind === "Video" ? "video" : "web_article",
          title: preview.title,
          contributors: preview.contributors,
          publication_date: preview.published_at,
        }}
        knownDescriptor={null}
        density="Row"
        returnFocus={() => findPaneLandmarkFocusTarget(pane.paneId)}
      />
      {acquisition}
    </PaneSurface>
  );
}
