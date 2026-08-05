"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  Ellipsis,
  Gauge,
  List,
  Mic,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
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
  PlayerStatus,
  PlayerTransport,
  playerMediaActionTarget,
  playerSourceHref,
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
  const [captureInMenu, setCaptureInMenu] = useState(false);
  const hidden = suspended || rootTextEntryFocused;
  const locked = playerTransportLocked(model);
  const chapters =
    model.kind === "Canonical"
      ? model.state.session.descriptor.activation.chapters
      : [];

  useLayoutEffect(() => {
    if (hidden || playerRef.current === null) return;
    return mobileViewport.registerBottomSurface("Player", playerRef.current);
  }, [hidden, mobileViewport]);

  useLayoutEffect(() => {
    const update = () => setCaptureInMenu(window.innerWidth <= 360);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const options: ActionDescriptor[] = [
    ...(model.kind === "Canonical" && captureInMenu
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
    // A canonical recording's open/source/media actions are the shared resource
    // dropdown (rendered separately below); a Preview is a transient resource
    // and keeps its own plain open/source controls.
    ...(model.kind === "Preview"
      ? [
          {
            id: "Player.OpenPreview",
            kind: "command" as const,
            label: "Open preview",
            onSelect: onOpenTarget,
          },
          {
            id: "Player.PreviewSource",
            kind: "link" as const,
            label: "Open source",
            href: playerSourceHref(model),
          },
        ]
      : []),
    ...(model.kind === "Canonical" && chapters.length > 0
      ? [
          {
            id: "Player.Contents",
            kind: "command" as const,
            label: "Contents",
            icon: <List aria-hidden="true" />,
            onSelect: onOpenContents,
          },
        ]
      : []),
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
        {model.kind === "Canonical" && !captureInMenu ? (
          <PlayerCaptureButton model={model} capture={capture} />
        ) : null}
        <PlayerTransport model={model} compact />
        {model.kind === "Canonical" ? (
          <ResourceActionMenu
            target={playerMediaActionTarget(model)}
            label="Recording actions"
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
