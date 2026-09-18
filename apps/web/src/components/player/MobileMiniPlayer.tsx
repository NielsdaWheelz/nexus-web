"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { Ellipsis, Gauge, SkipBack, SkipForward, X } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import {
  useMobileViewport,
  useRootTextEntryFocused,
} from "@/lib/mobileViewport/MobileViewportProvider";
import {
  usePlayerCommands,
  usePlayerSettings,
} from "@/lib/player/globalPlayer";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import { playerTransportLocked } from "@/lib/player/playerChromeModel";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PlayerCaptureController } from "@/lib/walknotes/usePlayerCapture";
import {
  PlayerCaptureButton,
  PlayerIdentity,
  PlayerMiniProgress,
  PlayerRecordingActionsMenu,
  PlayerStatus,
  PlayerTransport,
  playerContentsAction,
  playerOpenLecternAction,
  playerPreviewActions,
  playerReviewCapturesAction,
  playerTitle,
  type PresentPlayerChrome,
} from "./PlayerControls";
import styles from "./MobileMiniPlayer.module.css";

export default function MobileMiniPlayer({
  model,
  capture,
  suspended,
  openerRef,
  onOpenNowPlaying,
  onOpenTarget,
  onOpenPlayback,
  onOpenContents,
  onOpenLectern,
  onDismiss,
}: {
  readonly model: PresentPlayerChrome;
  readonly capture: PlayerCaptureController;
  readonly suspended: boolean;
  readonly openerRef: RefObject<HTMLButtonElement | null>;
  readonly onOpenNowPlaying: () => void;
  readonly onOpenTarget: () => void;
  readonly onOpenPlayback: (trigger: HTMLButtonElement | null) => void;
  readonly onOpenContents: () => void;
  readonly onOpenLectern: () => void;
  readonly onDismiss: () => void;
}) {
  const mobileViewport = useMobileViewport();
  const rootTextEntryFocused = useRootTextEntryFocused();
  const commands = usePlayerCommands();
  const settings = usePlayerSettings();
  const playerRef = useRef<HTMLElement>(null);
  const hidden = suspended || rootTextEntryFocused;
  const locked = playerTransportLocked(model);

  useLayoutEffect(() => {
    if (hidden || playerRef.current === null) return;
    return mobileViewport.registerBottomSurface("Player", playerRef.current);
  }, [hidden, mobileViewport]);

  const options: ActionDescriptor[] = [
    ...playerReviewCapturesAction(model, capture),
    {
      id: "Player.Playback",
      kind: "command",
      label: `Playback speed, ${formatPlaybackRate(
        settings.playbackRate.base,
      )}`,
      icon: <Gauge aria-hidden="true" />,
      onSelect: ({ triggerEl }) => onOpenPlayback(triggerEl),
    },
    ...(model.kind === "Canonical"
      ? [
          {
            id: "Player.Previous",
            kind: "command" as const,
            label: "Previous",
            icon: <SkipBack aria-hidden="true" />,
            disabled: locked,
            onSelect: commands.previous,
          },
          {
            id: "Player.Next",
            kind: "command" as const,
            label: "Next",
            icon: <SkipForward aria-hidden="true" />,
            disabled: locked || model.nextPreview.kind === "None",
            onSelect: commands.next,
          },
        ]
      : []),
    ...playerPreviewActions(model, onOpenTarget),
    ...playerContentsAction(model, onOpenContents),
    ...playerOpenLecternAction(model, onOpenLectern),
    {
      id: "Player.Close",
      kind: "command",
      label: "Close player",
      icon: <X aria-hidden="true" />,
      separatorBefore: true,
      onSelect: onDismiss,
    },
  ];

  return (
    <footer
      ref={playerRef}
      className={styles.miniPlayer}
      role="region"
      aria-label="Media player"
      aria-hidden={hidden || undefined}
      inert={hidden}
      data-hidden={hidden ? "true" : "false"}
    >
      <PlayerMiniProgress />
      <div className={styles.row}>
        <PlayerIdentity
          model={model}
          artworkSize={44}
          className={styles.identity}
          ariaLabel={`Open Now Playing: ${playerTitle(model)}`}
          buttonRef={openerRef}
          onOpen={onOpenNowPlaying}
        />
        {model.kind === "Canonical" ? (
          <PlayerCaptureButton model={model} capture={capture} />
        ) : null}
        <PlayerTransport model={model} compact />
        <PlayerRecordingActionsMenu
          model={model}
          renderTrigger={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="lg"
              iconOnly
              className={styles.more}
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
              className={styles.more}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          )}
        />
      </div>
      <PlayerStatus model={model} />
    </footer>
  );
}
