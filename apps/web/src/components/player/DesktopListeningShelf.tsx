"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Ellipsis, Gauge, List, Mic, X } from "lucide-react";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PlayerCaptureController } from "@/lib/walknotes/usePlayerCapture";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import PlayerAudioEffectsControls from "./PlayerAudioEffectsControls";
import { PlayerChapterList } from "./PlayerContentsSheet";
import {
  PlayerCaptureButton,
  PlayerIdentity,
  PlayerSeek,
  PlayerSpeedControl,
  PlayerStatus,
  PlayerTransport,
  PlayerVolumeControl,
  playerSourceHref,
  type PresentPlayerChrome,
} from "./PlayerControls";
import styles from "./DesktopListeningShelf.module.css";

function nextProvenance(model: PresentPlayerChrome): string | null {
  if (model.kind !== "Canonical") return null;
  if (model.nextPreview.kind === "Forward") {
    return `Forward: ${model.nextPreview.descriptor.title}`;
  }
  if (model.nextPreview.kind === "Lectern") {
    return `Next on the Lectern: ${model.nextPreview.descriptor.title}`;
  }
  return null;
}

export default function DesktopListeningShelf({
  model,
  capture,
  onOpenTarget,
  onOpenLectern,
  onDismiss,
  suspended,
}: {
  readonly model: PresentPlayerChrome;
  readonly capture: PlayerCaptureController;
  readonly onOpenTarget: () => void;
  readonly onOpenLectern: () => void;
  readonly onDismiss: () => void;
  readonly suspended: boolean;
}) {
  const shelfRef = useRef<HTMLElement>(null);
  const [compactActions, setCompactActions] = useState(false);
  const chapters =
    model.kind === "Canonical"
      ? model.state.session.descriptor.activation.chapters
      : [];
  const options: ActionDescriptor[] = [
    ...(model.kind === "Canonical" && compactActions
      ? [
          {
            id: "Player.Capture",
            kind: "custom" as const,
            label: "Capture this moment",
            icon: <Mic aria-hidden="true" />,
            render: ({ closeMenu }: { closeMenu: () => void }) => (
              <PlayerCaptureButton
                model={model}
                capture={capture}
                afterCapture={closeMenu}
              />
            ),
          },
        ]
      : []),
    ...(model.kind === "Canonical"
      ? [
          {
            id: "Player.ReviewCaptures",
            kind: "command" as const,
            label: `Review captures (${capture.waypointCount})`,
            icon: <Mic aria-hidden="true" />,
            onSelect: capture.openReview,
          },
        ]
      : []),
    ...(compactActions
      ? [
          {
            id: "Player.PlaybackSettings",
            kind: "custom" as const,
            label: "Playback settings",
            render: () => (
              <div className={styles.menuSettings}>
                <PlayerSpeedControl />
                <PlayerVolumeControl />
              </div>
            ),
          },
        ]
      : []),
    {
      id: "Player.AudioEffects",
      kind: "custom",
      label: "Audio effects",
      icon: <Gauge aria-hidden="true" />,
      render: () => (
        <div className={styles.menuEffects}>
          <PlayerAudioEffectsControls />
        </div>
      ),
    },
    ...(model.kind === "Canonical" && chapters.length > 0
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
    {
      id: "Player.OpenTrack",
      kind: "command",
      label: model.kind === "Canonical" ? "Open recording" : "Open preview",
      onSelect: onOpenTarget,
    },
    {
      id: "Player.OpenSource",
      kind: "link",
      label: "Open source",
      href: playerSourceHref(model),
    },
    ...(model.kind === "Canonical"
      ? [
          {
            id: "Player.OpenLectern",
            kind: "command" as const,
            label: "Open Lectern",
            onSelect: onOpenLectern,
          },
        ]
      : []),
  ];

  useLayoutEffect(() => {
    const shelf = shelfRef.current;
    if (!shelf) return;
    const update = () => setCompactActions(shelf.clientWidth < 1088);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shelf);
    return () => observer.disconnect();
  }, []);

  return (
    <footer
      ref={shelfRef}
      className={styles.shelf}
      role="region"
      aria-label="Media player"
      aria-hidden={suspended || undefined}
      inert={suspended}
    >
      <div className={styles.identityField}>
        <PlayerIdentity model={model} artworkSize={48} onOpen={onOpenTarget} />
        {nextProvenance(model) ? (
          <span className={styles.provenance}>{nextProvenance(model)}</span>
        ) : null}
      </div>

      <div className={styles.listeningField}>
        <PlayerTransport model={model} />
        <PlayerSeek model={model} />
        <PlayerStatus model={model} />
      </div>

      <div className={styles.actionField}>
        {model.kind === "Canonical" && !compactActions ? (
          <PlayerCaptureButton model={model} capture={capture} />
        ) : null}
        {!compactActions ? (
          <>
            <span className={styles.desktopSetting}>
              <PlayerSpeedControl />
            </span>
            <span className={styles.desktopSetting}>
              <PlayerVolumeControl />
            </span>
          </>
        ) : null}
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
