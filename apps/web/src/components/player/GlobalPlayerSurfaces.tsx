"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import WalknoteReviewPanel from "@/components/walknotes/WalknoteReviewPanel";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/globalPlayer";
import { projectPlayerChrome } from "@/lib/player/playerChromeModel";
import { usePlayerCapture } from "@/lib/walknotes/usePlayerCapture";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import DesktopListeningShelf from "./DesktopListeningShelf";
import MobileMiniPlayer from "./MobileMiniPlayer";
import MobileNowPlaying from "./MobileNowPlaying";
import PlayerAudioEffectsSheet from "./PlayerAudioEffectsSheet";
import PlayerContentsSheet from "./PlayerContentsSheet";
import {
  playerTargetHref,
  playerTitle,
  type PresentPlayerChrome,
} from "./PlayerControls";
import styles from "./GlobalPlayerSurfaces.module.css";

function playerAnnouncement(model: PresentPlayerChrome): string | null {
  if (
    model.state.kind === "PlaybackFailed" ||
    model.state.kind === "PreviewAudioFailed"
  ) {
    return model.state.error.message;
  }
  if (model.state.kind === "CompletionFailed") {
    return "Progress not saved";
  }
  if (model.kind === "Canonical" && model.persistence.kind === "Suspended") {
    return "Progress sync paused";
  }
  return null;
}

export default function GlobalPlayerSurfaces() {
  const session = usePlayerSession();
  const commands = usePlayerCommands();
  const capture = usePlayerCapture();
  const workspace = useWorkspaceStore();
  const isMobile = useIsMobileViewport();
  const model = projectPlayerChrome(session);
  const miniPlayerButtonRef = useRef<HTMLButtonElement>(null);
  const announcedIdentityRef = useRef<string | null>(null);
  const activeSessionIdentityRef = useRef<string | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [playbackOpen, setPlaybackOpen] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const closeSubordinates = useCallback(() => {
    setPlaybackOpen(false);
    setContentsOpen(false);
    capture.closeReview();
  }, [capture]);

  const collapse = useCallback(() => {
    closeSubordinates();
    setNowPlayingOpen(false);
  }, [closeSubordinates]);

  const dismiss = useCallback(() => {
    const activePaneId = workspace.state.activePrimaryPaneId;
    capture.closeForPlayerDismissal();
    setPlaybackOpen(false);
    setContentsOpen(false);
    setNowPlayingOpen(false);
    setAnnouncement("Player closed");
    commands.dismiss();
    requestAnimationFrame(() =>
      findPaneChromeFocusTarget(activePaneId)?.focus(),
    );
  }, [capture, commands, workspace.state.activePrimaryPaneId]);

  useEffect(() => {
    const identity =
      model.kind === "Absent"
        ? null
        : model.kind === "Canonical"
          ? model.state.session.descriptor.mediaId
          : model.state.session.descriptor.target;
    if (
      activeSessionIdentityRef.current !== null &&
      activeSessionIdentityRef.current !== identity
    ) {
      capture.closeForPlayerDismissal();
      setPlaybackOpen(false);
      setContentsOpen(false);
      if (identity === null) setAnnouncement("Player closed");
    }
    activeSessionIdentityRef.current = identity;

    if (!isMobile || model.kind === "Absent") {
      setNowPlayingOpen(false);
      setPlaybackOpen(false);
      setContentsOpen(false);
    }
  }, [capture, isMobile, model]);

  useEffect(() => {
    if (model.kind === "Absent") {
      announcedIdentityRef.current = null;
      return;
    }
    const identity =
      model.kind === "Canonical"
        ? model.state.session.descriptor.mediaId
        : model.state.session.descriptor.target;
    if (identity !== announcedIdentityRef.current) {
      announcedIdentityRef.current = identity;
      setAnnouncement(`Now playing: ${playerTitle(model)}`);
      return;
    }
    const status = playerAnnouncement(model);
    if (status !== null) setAnnouncement(status);
  }, [model]);

  useEffect(() => {
    if (capture.announcement) {
      setAnnouncement(capture.announcement);
    }
  }, [capture.announcement]);

  const activateTarget = useCallback(
    (target: { readonly href: string; readonly labelHint: string }) => {
      workspace.activateWorkspaceTarget({
        originPaneId: workspace.state.activePrimaryPaneId,
        target,
        disposition: { kind: "Follow" },
        modality: "Programmatic",
      });
    },
    [workspace],
  );

  const openPlayerTarget = useCallback(() => {
    if (model.kind === "Absent") return;
    collapse();
    activateTarget({
      href: playerTargetHref(model),
      labelHint: playerTitle(model),
    });
  }, [activateTarget, collapse, model]);

  const openLectern = useCallback(() => {
    collapse();
    activateTarget({ href: "/lectern", labelHint: "Lectern" });
  }, [activateTarget, collapse]);

  const liveRegion = (
    <span
      className={styles.liveRegion}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {announcement}
    </span>
  );

  if (model.kind === "Absent") return liveRegion;

  const chapters =
    model.kind === "Canonical"
      ? model.state.session.descriptor.activation.chapters
      : [];
  const modalActive =
    nowPlayingOpen || playbackOpen || contentsOpen || capture.reviewOpen;
  const subordinateActive = playbackOpen || contentsOpen || capture.reviewOpen;

  return (
    <>
      {liveRegion}
      {isMobile ? (
        <>
          <MobileMiniPlayer
            model={model}
            capture={capture}
            suspended={modalActive}
            openerRef={miniPlayerButtonRef}
            onOpenNowPlaying={() => setNowPlayingOpen(true)}
            onOpenTarget={openPlayerTarget}
            onOpenPlayback={() => setPlaybackOpen(true)}
            onOpenContents={() => setContentsOpen(true)}
            onOpenLectern={openLectern}
            onDismiss={dismiss}
          />
          <MobileNowPlaying
            active={nowPlayingOpen}
            model={model}
            capture={capture}
            suspended={subordinateActive}
            miniPlayerButtonRef={miniPlayerButtonRef}
            returnFocusFallback={() =>
              findPaneChromeFocusTarget(workspace.state.activePrimaryPaneId)
            }
            onOpenPlayback={() => setPlaybackOpen(true)}
            onOpenContents={() => setContentsOpen(true)}
            onCollapse={collapse}
            onOpenTarget={openPlayerTarget}
            onOpenLectern={openLectern}
            onDismiss={dismiss}
          />
          <PlayerAudioEffectsSheet
            active={playbackOpen}
            onDismiss={() => setPlaybackOpen(false)}
          />
          <PlayerContentsSheet
            active={contentsOpen}
            chapters={chapters}
            onDismiss={() => setContentsOpen(false)}
          />
        </>
      ) : (
        <DesktopListeningShelf
          model={model}
          capture={capture}
          onOpenTarget={openPlayerTarget}
          onOpenLectern={openLectern}
          onDismiss={dismiss}
          suspended={capture.reviewOpen}
        />
      )}
      {model.kind === "Canonical" && capture.reviewOpen ? (
        <WalknoteReviewPanel
          playerTask
          onClose={capture.closeReview}
          returnFocusFallback={() =>
            document.querySelector<HTMLElement>("[data-player-capture]") ??
            findPaneChromeFocusTarget(workspace.state.activePrimaryPaneId)
          }
          onMaterializeComplete={capture.announceMaterialized}
        />
      ) : null}
    </>
  );
}
