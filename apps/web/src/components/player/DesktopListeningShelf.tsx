"use client";

import type { RefObject } from "react";
import { Ellipsis, List, X } from "lucide-react";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PlayerCaptureController } from "@/lib/walknotes/usePlayerCapture";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { PlayerChapterList } from "./PlayerContentsSheet";
import {
  PlayerCaptureButton,
  PlayerIdentity,
  PlayerRecordingActionsMenu,
  PlayerSeek,
  PlayerStatus,
  PlayerTransport,
  PlayerVolumeControl,
  playerChapters,
  playerNextProvenance,
  playerOpenLecternAction,
  playerPreviewActions,
  playerReviewCapturesAction,
  type PresentPlayerChrome,
} from "./PlayerControls";
import { PlayerPlaybackRateButton } from "./PlayerPlaybackControls";
import styles from "./DesktopListeningShelf.module.css";

export default function DesktopListeningShelf({
  model,
  capture,
  onOpenTarget,
  onOpenLectern,
  onOpenPlayback,
  onDismiss,
  suspended,
  playbackButtonRef,
}: {
  readonly model: PresentPlayerChrome;
  readonly capture: PlayerCaptureController;
  readonly onOpenTarget: () => void;
  readonly onOpenLectern: () => void;
  readonly onOpenPlayback: () => void;
  readonly onDismiss: () => void;
  readonly suspended: boolean;
  readonly playbackButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const chapters = playerChapters(model);
  const provenance = playerNextProvenance(model);
  const options: ActionDescriptor[] = [
    ...playerReviewCapturesAction(model, capture),
    ...(chapters.length > 0
      ? [
          {
            id: "Player.Contents",
            kind: "custom" as const,
            label: "Contents",
            icon: <List aria-hidden="true" />,
            render: () => <PlayerChapterList chapters={chapters} />,
          },
        ]
      : []),
    ...playerPreviewActions(model, onOpenTarget),
    ...playerOpenLecternAction(model, onOpenLectern),
  ];

  return (
    <footer
      className={styles.shelf}
      role="region"
      aria-label="Media player"
      aria-hidden={suspended || undefined}
      inert={suspended}
    >
      <div className={styles.identityField}>
        <PlayerIdentity model={model} artworkSize={48} onOpen={onOpenTarget} />
        {provenance ? (
          <span className={styles.provenance}>{provenance}</span>
        ) : null}
      </div>

      <div className={styles.listeningField}>
        <PlayerTransport model={model} />
        <PlayerSeek model={model} />
        <PlayerStatus model={model} />
      </div>

      <div className={styles.actionField}>
        {model.kind === "Canonical" ? (
          <PlayerCaptureButton model={model} capture={capture} />
        ) : null}
        <PlayerPlaybackRateButton
          ref={playbackButtonRef}
          onClick={onOpenPlayback}
        />
        <PlayerVolumeControl />
        <PlayerRecordingActionsMenu
          model={model}
          renderTrigger={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="lg"
              iconOnly
              className={styles.iconButton}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          )}
        />
        <ActionMenu
          options={options}
          label="More player controls"
          placement="above"
          renderTrigger={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="lg"
              iconOnly
              className={styles.iconButton}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          )}
        />
        <Button
          variant="ghost"
          size="lg"
          iconOnly
          className={styles.iconButton}
          onClick={onDismiss}
          aria-label="Close player"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </footer>
  );
}
