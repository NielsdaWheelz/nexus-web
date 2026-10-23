"use client";

import { lazy, Suspense } from "react";
import PodcastAcquisitionDialog from "@/components/podcasts/PodcastAcquisitionDialog";
import PodcastLibrariesOverlay from "@/components/podcasts/PodcastLibrariesOverlay";
import PodcastStopDialog from "@/components/podcasts/PodcastStopDialog";
import LibrarySettingsDialog from "@/components/LibrarySettingsDialog";
import MediaInfoOverlay from "@/components/media/MediaInfoOverlay";
import PodcastSettingsOverlay from "@/components/podcasts/PodcastSettingsOverlay";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import type { Overlay } from "@/lib/actions/ResourceActionsProvider";
import { PaneReturnVisitScope } from "@/lib/workspace/paneReturnMemento";

const MediaAuthorsEditor = lazy(
  () => import("@/components/contributors/MediaAuthorsEditor"),
);

/**
 * The overlays verbs open, under one synthetic pane visit so their
 * pane-coupled controls have a scope. Each overlay loads its own facts;
 * account commands survive presentation dismissal.
 */
export function ResourceOverlays({
  overlay,
  close,
}: {
  readonly overlay:
    | (Overlay & {
        readonly key: number;
        readonly open: boolean;
        readonly anchor: ReturnFocusTarget;
        readonly focusFallback: ReturnFocusTarget;
      })
    | null;
  readonly close: () => void;
}) {
  return (
    <PaneReturnVisitScope
      visitId="resource-action-overlays"
      routeKey="resource-action-overlays"
    >
      {overlay?.kind === "Authors" ? (
        <Suspense fallback={null}>
          <MediaAuthorsEditor
            key={overlay.key}
            mediaId={overlay.mediaId}
            returnFocusTo={overlay.anchor}
            onClose={close}
          />
        </Suspense>
      ) : null}
      {overlay?.kind === "Metadata" ? (
        <MediaInfoOverlay
          key={overlay.key}
          open={overlay.open}
          mediaId={overlay.mediaId}
          returnFocusTo={() =>
            overlay.returnFocusTo?.isConnected
              ? overlay.returnFocusTo
              : overlay.fallback()
          }
          returnFocusFallback={overlay.fallback}
          onClose={close}
        />
      ) : null}
      {overlay?.kind === "LibrarySettings" ? (
        <LibrarySettingsDialog
          key={overlay.key}
          libraryId={overlay.libraryId}
          onClose={close}
        />
      ) : null}
      {overlay?.kind === "PodcastSettings" ? (
        <PodcastSettingsOverlay
          key={overlay.key}
          podcastId={overlay.podcastId}
          onClose={close}
        />
      ) : null}
      {overlay?.kind === "PodcastLibraries" ? <PodcastLibrariesOverlay key={overlay.key} target={overlay.target} title={overlay.title} anchor={overlay.anchor} returnFocusFallback={overlay.focusFallback} successFocus={overlay.successFocus} onClose={close} /> : null}
      {overlay?.kind === "SubscribePodcast" ? <PodcastAcquisitionDialog key={overlay.key} mode="follow" target={overlay.target} title={overlay.title} libraryId={overlay.libraryId} onAccepted={overlay.onAccepted} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "ImportPodcastEpisodes" ? <PodcastAcquisitionDialog key={overlay.key} mode="current_episodes" target={overlay.target} title={overlay.title} libraryId={null} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "UnsubscribePodcast" ? <PodcastStopDialog key={overlay.key} podcastId={overlay.podcastId} title={overlay.title} libraryId={overlay.libraryId} episodes="keep" successFocus={overlay.successFocus} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "RemovePodcastEpisodes" ? <PodcastStopDialog key={overlay.key} podcastId={overlay.podcastId} title={overlay.title} libraryId={null} episodes="remove" returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
    </PaneReturnVisitScope>
  );
}
