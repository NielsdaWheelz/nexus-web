"use client";

import { lazy, Suspense } from "react";
import AcquisitionControl from "@/components/browse/AcquisitionControl";
import LibrarySettingsDialog from "@/components/LibrarySettingsDialog";
import MediaInfoOverlay from "@/components/media/MediaInfoOverlay";
import PodcastSubscriptionSettingsOverlay from "@/components/podcasts/PodcastSubscriptionSettingsOverlay";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import type { Overlay } from "@/lib/actions/ResourceActionsProvider";
import { subscribeToPodcast } from "@/lib/podcasts/api";
import { useWorkGuard } from "@/lib/unsavedWork";
import { PaneReturnVisitScope } from "@/lib/workspace/paneReturnMemento";
import styles from "./ResourceOverlays.module.css";

const MediaAuthorsEditor = lazy(
  () => import("@/components/contributors/MediaAuthorsEditor"),
);

/**
 * The overlays verbs open, under one synthetic pane visit so their
 * pane-coupled controls have a scope. Each overlay loads its own facts and
 * refuses to close while its own save runs.
 */
export function ResourceOverlays({
  overlay,
  close,
}: {
  readonly overlay:
    | (Overlay & {
        readonly key: number;
        readonly open: boolean;
        readonly opener: HTMLElement | null;
      })
    | null;
  readonly close: () => void;
}) {
  const guard = useWorkGuard();
  const mayDismiss = () => guard.confirmLoss({
    scopes: [{ kind: "visit", visitId: "resource-action-overlays", routeKey: "resource-action-overlays" }], ownerIds: [],
  });
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
            returnFocusTo={() => overlay.opener}
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
        <PodcastSubscriptionSettingsOverlay
          key={overlay.key}
          podcastId={overlay.podcastId}
          onClose={close}
        />
      ) : null}
      {overlay?.kind === "Subscribe" ? (
        <Dialog key={overlay.key} open onClose={close} onDismissRequest={() => mayDismiss() ? "accepted" : "blocked"} title="Subscribe">
          <div className={styles.subscribe}>
            <p>Subscribe to this podcast and choose where to file it.</p>
            <AcquisitionControl
              key={overlay.podcastId}
              kind="Subscribe"
              commit={async (command) => {
                const result = await subscribeToPodcast({
                  target: { kind: "Canonical", podcast_id: overlay.podcastId },
                  namedLibraryIds: command.namedLibraryIds,
                  replaceEpisodes: command.replaceEpisodes,
                });
                return { href: result.href };
              }}
              onCommitted={close}
            />
            <div>
              <Button variant="ghost" size="sm" onClick={() => { if (mayDismiss()) close(); }}>
                Cancel
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </PaneReturnVisitScope>
  );
}
