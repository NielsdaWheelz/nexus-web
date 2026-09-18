"use client";

import { useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Ellipsis, X } from "lucide-react";
import Button from "@/components/ui/Button";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import { useHistoryDismiss } from "@/lib/ui/useHistoryDismiss";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import type { PlayerCaptureController } from "@/lib/walknotes/usePlayerCapture";
import {
  PlayerArtwork,
  PlayerCaptureButton,
  PlayerContentsButton,
  PlayerCurrentChapterLine,
  PlayerSeek,
  PlayerRecordingActionsMenu,
  PlayerStatus,
  PlayerTransport,
  playerChapters,
  playerNextProvenance,
  playerSourceHref,
  playerTitle,
  type PresentPlayerChrome,
} from "./PlayerControls";
import { PlayerPlaybackRateButton } from "./PlayerPlaybackControls";
import styles from "./MobileNowPlaying.module.css";

export default function MobileNowPlaying({
  active,
  model,
  capture,
  suspended,
  miniPlayerButtonRef,
  playbackButtonRef,
  returnFocusFallback,
  onOpenPlayback,
  onOpenContents,
  onCollapse,
  onOpenTarget,
  onOpenLectern,
  onDismiss,
}: {
  readonly active: boolean;
  readonly model: PresentPlayerChrome;
  readonly capture: PlayerCaptureController;
  readonly suspended: boolean;
  readonly miniPlayerButtonRef: RefObject<HTMLButtonElement | null>;
  readonly playbackButtonRef: RefObject<HTMLButtonElement | null>;
  readonly returnFocusFallback: () => HTMLElement | null;
  readonly onOpenPlayback: () => void;
  readonly onOpenContents: () => void;
  readonly onCollapse: () => void;
  readonly onOpenTarget: () => void;
  readonly onOpenLectern: () => void;
  readonly onDismiss: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const title = playerTitle(model);
  const chapters = playerChapters(model);
  const provenance = playerNextProvenance(model);

  const overlay = useDialogOverlay({
    ref: panelRef,
    active,
    onDismiss: onCollapse,
    initialFocus: () => headingRef.current,
    returnFocusTo: () => miniPlayerButtonRef.current,
    returnFocusFallback,
    focusKey: title,
    layerScope: "Player.NowPlaying",
  });
  useHistoryDismiss(active, onCollapse, { isTopmost: overlay.isTopmost });

  if (!active) return null;
  return createPortal(
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.backdrop}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
      >
        <section
          ref={panelRef}
          className={styles.nowPlaying}
          role="dialog"
          aria-label="Now Playing"
        >
          <div
            role="region"
            aria-label="Media player"
            aria-hidden={suspended || undefined}
            className={styles.frame}
          >
            <header className={styles.header}>
              <Button
                variant="ghost"
                size="lg"
                iconOnly
                onClick={onCollapse}
                aria-label="Collapse player"
              >
                <ChevronDown aria-hidden="true" />
              </Button>
              <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
                Now Playing
              </h1>
            </header>

            <div className={styles.body}>
              <div className={styles.artworkField}>
                <PlayerArtwork
                  model={model}
                  size={480}
                  className={styles.artwork}
                  fluid
                />
              </div>

              <div className={styles.identityField}>
                <span className={styles.kicker}>
                  {model.kind === "Canonical"
                    ? model.state.session.origin.kind === "Lectern"
                      ? "From your Lectern"
                      : "Now playing"
                    : `Preview from ${model.state.session.descriptor.source}`}
                </span>
                <h2 className={styles.title}>{title}</h2>
                {model.kind === "Canonical" &&
                model.state.session.descriptor.subtitle.kind === "Present" ? (
                  <p className={styles.subtitle}>
                    {model.state.session.descriptor.subtitle.value}
                  </p>
                ) : null}
                {model.kind === "Canonical" ? (
                  <PlayerCurrentChapterLine className={styles.currentChapter} />
                ) : null}
              </div>

              <PlayerStatus model={model} />
              <PlayerSeek model={model} />
              <PlayerTransport model={model} />
              <PlayerPlaybackRateButton
                ref={playbackButtonRef}
                onClick={onOpenPlayback}
              />

              {model.kind === "Canonical" ? (
                <PlayerCaptureButton model={model} capture={capture} />
              ) : null}

              <div className={styles.secondaryActions}>
                {model.kind === "Canonical" && chapters.length > 0 ? (
                  <span data-player-contents>
                    <PlayerContentsButton onClick={onOpenContents} />
                  </span>
                ) : null}
                {model.kind === "Canonical" ? (
                  <PlayerRecordingActionsMenu
                    model={model}
                    align="center"
                    renderTrigger={(props) => (
                      <Button
                        {...props}
                        variant="ghost"
                        size="lg"
                        leadingIcon={<Ellipsis aria-hidden="true" />}
                      >
                        Recording actions
                      </Button>
                    )}
                  />
                ) : (
                  <>
                    <Button variant="ghost" size="lg" onClick={onOpenTarget}>
                      Open preview
                    </Button>
                    <Button variant="ghost" size="lg" asChild>
                      <a
                        href={playerSourceHref(model)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open source
                      </a>
                    </Button>
                  </>
                )}
                {model.kind === "Canonical" ? (
                  <>
                    <Button
                      variant="ghost"
                      size="lg"
                      onClick={capture.openReview}
                    >
                      Review captures ({capture.waypointCount})
                    </Button>
                    <Button variant="ghost" size="lg" onClick={onOpenLectern}>
                      Open Lectern
                    </Button>
                  </>
                ) : null}
              </div>

              {provenance ? (
                <p className={styles.provenance}>{provenance}</p>
              ) : null}

              <Button
                variant="ghost"
                size="lg"
                className={styles.close}
                onClick={onDismiss}
                leadingIcon={<X aria-hidden="true" />}
              >
                Close player
              </Button>
            </div>
          </div>
        </section>
      </div>
    </ModalLayerProvider>,
    document.body,
  );
}
