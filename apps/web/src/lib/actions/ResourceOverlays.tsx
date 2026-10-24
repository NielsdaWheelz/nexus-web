"use client";

import PodcastAcquisitionDialog from "@/components/podcasts/PodcastAcquisitionDialog";
import PodcastStopDialog from "@/components/podcasts/PodcastStopDialog";
import LibrarySettingsDialog from "@/components/LibrarySettingsDialog";
import ResourceMetadataOverlay from "@/components/resources/ResourceMetadataOverlay";
import CollectionConsumptionDialog from "@/components/collections/CollectionConsumptionDialog";
import CollectionLecternDialog from "@/components/collections/CollectionLecternDialog";
import PodcastLibrariesDialog from "@/components/podcasts/PodcastLibrariesDialog";
import PodcastTranscriptDialog from "@/components/podcasts/PodcastTranscriptDialog";
import PodcastSettingsOverlay from "@/components/podcasts/PodcastSettingsOverlay";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import type { Overlay } from "@/lib/actions/ResourceActionsProvider";
import { PaneReturnVisitScope } from "@/lib/workspace/paneReturnMemento";

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
      {overlay?.kind === "Metadata" ? (
        <ResourceMetadataOverlay
          key={overlay.key}
          open={overlay.open}
          subject={overlay.subject}
          returnFocusTo={() =>
            overlay.returnFocusTo?.isConnected
              ? overlay.returnFocusTo
              : overlay.fallback()
          }
          returnFocusFallback={overlay.fallback}
          onClose={close}
        />
      ) : null}
      {overlay?.kind === "CollectionConsumption" ? <CollectionConsumptionDialog key={overlay.key} selection={overlay.selection} desiredState={overlay.desiredState} title={overlay.title} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "CollectionLectern" ? <CollectionLecternDialog key={overlay.key} target={overlay.target} title={overlay.title} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "PodcastLibraries" ? <PodcastLibrariesDialog key={overlay.key} target={overlay.target} title={overlay.title} successFocus={overlay.successFocus} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "TranscribePodcastEpisodes" ? <PodcastTranscriptDialog key={overlay.key} podcastId={overlay.podcastId} title={overlay.title} state={overlay.state} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
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
      {overlay?.kind === "SubscribePodcast" ? <PodcastAcquisitionDialog key={overlay.key} mode="follow" target={overlay.target} title={overlay.title} libraryId={overlay.libraryId} onAccepted={overlay.onAccepted} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "ImportPodcastEpisodes" ? <PodcastAcquisitionDialog key={overlay.key} mode="current_episodes" target={overlay.target} title={overlay.title} libraryId={null} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "UnsubscribePodcast" ? <PodcastStopDialog key={overlay.key} podcastId={overlay.podcastId} title={overlay.title} libraryId={overlay.libraryId} episodes="keep" successFocus={overlay.successFocus} returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
      {overlay?.kind === "RemovePodcastEpisodes" ? <PodcastStopDialog key={overlay.key} podcastId={overlay.podcastId} title={overlay.title} libraryId={null} episodes="remove" returnFocusTo={overlay.anchor} returnFocusFallback={overlay.focusFallback} onClose={close} /> : null}
    </PaneReturnVisitScope>
  );
}
