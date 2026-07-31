"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import WalknoteReviewPanel from "@/components/walknotes/WalknoteReviewPanel";
import { presenceValueOr } from "@/lib/api/presence";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  usePlayerCommands,
  usePlayerSession,
  usePlayerSettings,
} from "@/lib/player/globalPlayer";
import { projectPlayerChrome } from "@/lib/player/playerChromeModel";
import { usePlayerCapture } from "@/lib/walknotes/usePlayerCapture";
import { useWorkspaceStore } from "@/lib/workspace/store";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { usePaneChromeFocusReturn } from "@/lib/workspace/mobileChrome";
import DesktopListeningShelf from "./DesktopListeningShelf";
import MobileMiniPlayer from "./MobileMiniPlayer";
import MobileNowPlaying from "./MobileNowPlaying";
import PlayerContentsSheet from "./PlayerContentsSheet";
import {
  PlayerPlaybackPanel,
  PlayerPlaybackSheet,
} from "./PlayerPlaybackControls";
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
  const settings = usePlayerSettings();
  const commands = usePlayerCommands();
  const capture = usePlayerCapture();
  const workspace = useWorkspaceStore();
  const { focus: returnPaneChromeFocus } = usePaneChromeFocusReturn();
  const isMobile = useIsMobileViewport();
  const model = projectPlayerChrome(session);
  const miniPlayerButtonRef = useRef<HTMLButtonElement>(null);
  const playbackButtonRef = useRef<HTMLButtonElement>(null);
  const playbackReturnFocusRef = useRef<HTMLElement | null>(null);
  const announcedIdentityRef = useRef<string | null>(null);
  const activeSessionIdentityRef = useRef<string | null>(null);
  const previousIsMobileRef = useRef(isMobile);
  const rememberAnnouncementRef = useRef("Unavailable");
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
    if (isMobile) {
      void returnPaneChromeFocus(activePaneId);
      return;
    }
    requestAnimationFrame(() =>
      findPaneChromeFocusTarget(activePaneId)?.focus(),
    );
  }, [
    capture,
    commands,
    isMobile,
    returnPaneChromeFocus,
    workspace.state.activePrimaryPaneId,
  ]);

  useEffect(() => {
    const viewportChanged = previousIsMobileRef.current !== isMobile;
    previousIsMobileRef.current = isMobile;
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

    if (viewportChanged || model.kind === "Absent") {
      setNowPlayingOpen(false);
      setPlaybackOpen(false);
      setContentsOpen(false);
    } else if (!isMobile) {
      setNowPlayingOpen(false);
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

  useEffect(() => {
    const remember = settings.playbackRate.remember;
    const signature =
      remember.kind === "Failed"
        ? `${remember.kind}:${remember.error.title}:${remember.error.message ?? ""}`
        : remember.kind;
    const previous = rememberAnnouncementRef.current;
    if (signature === previous) return;
    rememberAnnouncementRef.current = signature;
    if (remember.kind === "Pending") {
      setAnnouncement("Remembering playback speed for this podcast");
    } else if (remember.kind === "Failed") {
      setAnnouncement(
        [remember.error.title, remember.error.message]
          .filter(Boolean)
          .join(". "),
      );
    } else if (remember.kind === "Ready" && previous === "Pending") {
      setAnnouncement("Podcast playback speed remembered");
    }
  }, [settings.playbackRate.remember]);

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

  const openPlayback = useCallback((returnFocusTo: HTMLElement | null) => {
    playbackReturnFocusRef.current = returnFocusTo;
    setPlaybackOpen(true);
  }, []);

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
  const podcastTitle =
    model.kind === "Canonical"
      ? presenceValueOr(model.state.session.descriptor.subtitle, null)
      : null;
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
            onOpenPlayback={openPlayback}
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
            playbackButtonRef={playbackButtonRef}
            returnFocusFallback={() =>
              findPaneLandmarkFocusTarget(workspace.state.activePrimaryPaneId)
            }
            onOpenPlayback={() => openPlayback(playbackButtonRef.current)}
            onOpenContents={() => setContentsOpen(true)}
            onCollapse={collapse}
            onOpenTarget={openPlayerTarget}
            onOpenLectern={openLectern}
            onDismiss={dismiss}
          />
          <PlayerPlaybackSheet
            active={playbackOpen}
            podcastTitle={podcastTitle}
            onDismiss={() => setPlaybackOpen(false)}
            returnFocusTo={() =>
              playbackReturnFocusRef.current ??
              playbackButtonRef.current ??
              miniPlayerButtonRef.current
            }
          />
          <PlayerContentsSheet
            active={contentsOpen}
            chapters={chapters}
            onDismiss={() => setContentsOpen(false)}
          />
        </>
      ) : (
        <>
          <DesktopListeningShelf
            model={model}
            capture={capture}
            onOpenTarget={openPlayerTarget}
            onOpenLectern={openLectern}
            onOpenPlayback={() => openPlayback(playbackButtonRef.current)}
            onDismiss={dismiss}
            suspended={capture.reviewOpen || playbackOpen}
            playbackButtonRef={playbackButtonRef}
          />
          <Dialog
            open={playbackOpen}
            onClose={() => setPlaybackOpen(false)}
            title="Playback"
            returnFocusTo={() =>
              playbackReturnFocusRef.current ?? playbackButtonRef.current
            }
          >
            <div role="region" aria-label="Media player">
              <PlayerPlaybackPanel podcastTitle={podcastTitle} />
            </div>
          </Dialog>
        </>
      )}
      {model.kind === "Canonical" && capture.reviewOpen ? (
        <WalknoteReviewPanel
          playerTask
          onClose={capture.closeReview}
          returnFocusFallback={() =>
            document.querySelector<HTMLElement>("[data-player-capture]") ??
            findPaneLandmarkFocusTarget(workspace.state.activePrimaryPaneId)
          }
          onMaterializeComplete={capture.announceMaterialized}
        />
      ) : null}
    </>
  );
}
