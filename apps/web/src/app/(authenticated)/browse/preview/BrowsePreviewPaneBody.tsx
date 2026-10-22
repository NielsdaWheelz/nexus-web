"use client";

// A preview shows something outside Nexus without acquiring it: opening,
// playing and leaving write nothing. Only AcquisitionControl acquires. A
// target already in Nexus redirects to its owned pane.

import { useEffect, useState } from "react";
import AcquisitionControl, {
  type AcquisitionCommand,
  type AcquisitionSuccess,
} from "@/components/browse/AcquisitionControl";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
  FeedbackStatus,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import YouTubeEmbedFrame from "@/components/media/YouTubeEmbedFrame";
import PodcastOverview from "@/components/podcasts/PodcastOverview";
import Button from "@/components/ui/Button";
import MediaImage from "@/components/ui/MediaImage";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import {
  browsePreviewHref,
  fetchBrowsePreview,
  type BrowsePreview,
} from "@/lib/browse/api";
import { BROWSE_SOURCE_LABELS } from "@/lib/browse/query";
import { formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { presentPreviewEpisode } from "@/lib/collections/presenters/browse";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import { addMediaFromUrl } from "@/lib/imports/ingest";
import {
  usePaneRouter,
  requirePaneRuntime,
  usePaneRuntime,
  usePaneSearchParams,
  usePreviewTitleHint,
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

/** The preview read owns the whole bounded snapshot; this section never fetches. */
function PreviewEpisodes({ preview }: {
  readonly preview: Extract<BrowsePreview, { kind: "Podcast" }>;
}) {
  const display = useRenderEnvironment();
  return (
    <PaneSection title="Episodes">
      <p className={styles.note}>{`directory preview: up to ${formatDisplayNumber(preview.episodes.source_limit, display)} episodes. playable episodes shown; full history may differ.`}</p>
      <CollectionView
        returnScope="Browse.Preview.PodcastEpisodes"
        rows={preview.episodes.items.map(presentPreviewEpisode)}
        status="ready"
        ariaLabel="Podcast episodes"
        empty={<FeedbackStatus content={{ tone: "Neutral", title: "no playable episodes in this directory preview" }} announcement="None" />}
        surface={false}
        rowActionsAvailable={false}
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
    load: (signal) => fetchBrowsePreview(target as string, signal),
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
    const { namedLibraryIds, idempotencyKey } = command;
    switch (preview.kind) {
      case "Podcast": {
        const result = await subscribeToPodcast({
          target: { kind: "Discovery", target: preview.target },
          namedLibraryIds,
          replaceEpisodes: command.replaceEpisodes,
        });
        return { href: result.href };
      }
      case "Episode": {
        const { href, media_id: mediaId } = await addEpisodeFromDiscovery({
          target: preview.target,
          namedLibraryIds,
        });
        return { href, mediaId };
      }
      default: {
        const url =
          preview.kind === "Epub"
            ? preview.kind_facts.import_href
            : preview.kind === "WebArticle"
              ? preview.kind_facts.canonical_url
              : preview.source_href;
        const { mediaId, href } = await addMediaFromUrl({
          url,
          libraryIds: namedLibraryIds,
          id: idempotencyKey,
        });
        return { href, mediaId };
      }
    }
  };
  const acquisition = (
    <AcquisitionControl
      key={preview.target}
      kind={preview.kind === "Podcast" ? "Subscribe" : "Add"}
      previewTarget={preview.target}
      commit={commit}
      openAfterCommit={{ originPaneId: pane.paneId, labelHint: preview.title }}
    />
  );
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
  const host = audio === null ? null : new URL(audio.audio_href).hostname;
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
                sourceHref: preview.source_href,
                audioUrl: audio.audio_href,
                imageUrl: image ? image : null,
                durationMs:
                  audio.duration_seconds !== null
                    ? (audio.duration_seconds * 1000)
                    : null,
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
