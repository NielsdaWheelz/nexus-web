"use client";

// Explicit podcast/episode opening resolves catalogue identity without filing.
// Preview reads remain read-only; the canonical show visit owns its source check.

import { useEffect, useRef, useState } from "react";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { resolvePodcast, resolvePodcastEpisode } from "@/lib/podcasts/api";
import { useCommand } from "@/lib/podcasts/paneState";
import MediaActions from "@/components/media/MediaActions";
import { ContributorRoleGroups } from "@/components/contributors/ContributorCredits";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { transportVerbs, type Verbs } from "@/components/feedback/stage";
import YouTubeEmbedFrame from "@/components/media/YouTubeEmbedFrame";
import Button from "@/components/ui/Button";
import MediaImage from "@/components/ui/MediaImage";
import PaneSurface from "@/components/ui/PaneSurface";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import {
  fetchBrowsePreview,
  type BrowsePreview,
} from "@/lib/browse/api";
import { BROWSE_SOURCE_LABELS } from "@/lib/browse/query";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import {
  usePaneRouter,
  requirePaneRuntime,
  usePaneRuntime,
  usePaneSearchParams,
  usePreviewTitleHint,
} from "@/lib/panes/paneRuntime";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { providerRefusal } from "../providerRefusal";
import styles from "../browse.module.css";

export default function BrowsePreviewPaneBody() {
  const display = useRenderEnvironment();
  const pane = requirePaneRuntime(usePaneRuntime(), "BrowsePreviewPaneBody");
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const target = params.get("target");
  const { ctx } = useActionRuntime();
  const resource = usePaneFreeServerValue<BrowsePreview>({
    key: target === null ? null : `browse-preview:${target}`,
    stale: "",
    // justify-type-assertion: the read runs only for a non-null key.
    load: (signal) => fetchBrowsePreview(target as string, signal),
  });
  const [videoLoaded, setVideoLoaded] = useState(false);
  const preview = resource.status === "ready" ? resource.data : null;
  const owned = preview !== null && preview.resolution.kind !== "Preview" ? preview.resolution.href : null;
  const opening = useCommand();
  const attempted = useRef(false);
  const resolve = () => {
    if (preview === null || (preview.kind !== "Podcast" && preview.kind !== "Episode") || owned !== null) return;
    opening.run(preview.kind === "Podcast" ? "couldn’t open this podcast." : "couldn’t open this episode.", async () => {
      const resolved = preview.kind === "Podcast" ? await resolvePodcast(preview.target, ctx.sessionSignal()) : await resolvePodcastEpisode(preview.target, ctx.sessionSignal());
      if (!ctx.isActive()) return;
      const current = ctx.workspace().state.panes.find(item => item.id === pane.paneId)?.current_visit;
      if (current?.id !== pane.visitId || current.href !== pane.href) return;
      router.replace(resolved.href, { labelHint: preview.title, activate: false });
    });
  };
  useEffect(() => {
    if (owned !== null) { router.replace(owned, { labelHint: preview?.title, activate: false }); return; }
    if (attempted.current || preview === null || resource.status !== "ready" || resource.refreshing || resource.error !== null || (preview.kind !== "Podcast" && preview.kind !== "Episode")) return;
    attempted.current = true;
    resolve();
  });
  const back = () =>
    router.canGoBack ? router.back({ disposition: { kind: "Follow" } }) : router.replace("/browse");
  const backVerbs: Verbs = [{ label: "back to browse", commandKey: "back to browse", run: back }];
  const retry = { run: () => { void resource.refetch().catch(() => {}); }, busy: resource.status === "failed" && resource.retrying };
  const refusal = resource.status === "failed" ? providerRefusal(resource.error, display) : null;
  const failure = target === null || resource.status === "failed" && resource.error.code === "E_INVALID_DISCOVERY_TARGET"
    ? <Fact line={{ fact: "this link has nothing to preview." }} verbs={backVerbs} />
    : resource.status !== "failed" ? null
    : resource.error.code === "E_NOT_FOUND" ? <Fact line={{ fact: "this item isn’t available from its source." }} verbs={backVerbs} />
    : refusal !== null ? <Fact line={{ fact: "couldn’t load preview details.", reason: refusal.reason }}
      verbs={refusal.retry ? [{ label: "retry", commandKey: "retry preview details", ...retry }] : undefined} />
    : <Failed error={resource.error} noun="preview details" retry={retry} />;
  usePreviewTitleHint(target, preview?.title);

  usePaneChrome({
    podcastMetadata: preview?.kind === "Podcast" ? { kind: "DiscoveryPodcastPreview", preview } : undefined,
    header:
      failure !== null
        ? { kind: "Resource", resource: { status: "Failed" } }
        : preview === null
          ? undefined
          : {
              kind: "Resource",
              resource: {
                status: "Ready",
                creditGroups: preview.kind === "Podcast" ? [] : [
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

  if (failure !== null) return <PaneSurface state={failure} />;
  if (preview === null || owned !== null || preview.kind === "Podcast" || preview.kind === "Episode") {
    return (
      <PaneSurface
        state={
          opening.failure !== null ? <Fact line={{ fact: opening.failure.title, reason: opening.failure.message }}
            verbs={opening.failure.reload ? transportVerbs("Update", { signIn: null }) ?? undefined
              : [{ label: "retry", commandKey: "retry opening", run: resolve, busy: opening.running !== null }]} />
            : <Ruling />
        }
      />
    );
  }

  // justify-type-assertion: the server issues every browse image as a media
  // image proxy src (services/browse/models.py proxied_image).
  const image =
    preview.image !== null
      ? (preview.image as MediaImageProxySrc)
      : null;
  const description = preview.description;

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
          <ContributorRoleGroups credits={preview.contributors} />
          {preview.published_at ? <p>source published: <time dateTime={preview.published_at}>{formatDisplayDate(preview.published_at, display, { dateStyle: "medium" })}</time></p> : null}
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
        <Button onClick={() => setVideoLoaded(true)}>
          Load video
        </Button>
      )}
      <MediaActions
        subject={{
          kind: "External",
          target: preview.target,
          media_kind: preview.kind === "Epub" ? "epub"
            : preview.kind === "Video" ? "video" : "web_article",
          title: preview.title,
          contributors: preview.contributors,
        }}
        knownDescriptor={null}
        density="Row"
        returnFocus={() => findPaneLandmarkFocusTarget(pane.paneId)}
      />
    </PaneSurface>
  );
}
