"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Ellipsis, List, Mic, X } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
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
  PlayerStatus,
  PlayerTransport,
  playerMediaActionSubject,
  playerSourceHref,
  playerTitle,
  type PresentPlayerChrome,
} from "./PlayerControls";
import { PlayerPlaybackRateButton } from "./PlayerPlaybackControls";
import styles from "./MobileNowPlaying.module.css";

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
  const [shortViewport, setShortViewport] = useState(false);
  const title = playerTitle(model);
  const chapters =
    model.kind === "Canonical"
      ? model.state.session.descriptor.activation.chapters
      : [];
  const provenance = nextProvenance(model);

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

  useEffect(() => {
    const update = () => setShortViewport(window.innerHeight < 680);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const secondaryOptions: ActionDescriptor[] = [
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
    // A canonical recording's open/source/media actions are the shared resource
    // dropdown (rendered separately below); a Preview is a transient resource
    // and keeps its own plain open/source controls.
    ...(model.kind === "Preview"
      ? [
          {
            id: "OccurrenceAction.PlayerPreview.Open",
            kind: "command" as const,
            label: "Open preview",
            onSelect: onOpenTarget,
          },
          {
            id: "OccurrenceAction.PlayerPreview.OpenSource",
            kind: "link" as const,
            label: "Open source",
            href: playerSourceHref(model),
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
          {
            id: "Player.OpenLectern",
            kind: "command" as const,
            label: "Open Lectern",
            onSelect: onOpenLectern,
          },
        ]
      : []),
  ];

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

              {shortViewport ? (
                <>
                  {model.kind === "Canonical" ? (
                    <ResourceActionMenu
                      actionSubject={playerMediaActionSubject(model)}
                      label="Recording actions"
                      placement="above"
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
                  ) : null}
                  <ActionMenu
                    options={secondaryOptions}
                    label="More Now Playing controls"
                    placement="above"
                    align="center"
                    renderTrigger={(props) => (
                      <Button
                        {...props}
                        variant="ghost"
                        size="lg"
                        leadingIcon={<Ellipsis aria-hidden="true" />}
                      >
                        More
                      </Button>
                    )}
                  />
                </>
              ) : (
                <div className={styles.secondaryActions}>
                  {model.kind === "Canonical" && chapters.length > 0 ? (
                    <span data-player-contents>
                      <PlayerContentsButton onClick={onOpenContents} />
                    </span>
                  ) : null}
                  {model.kind === "Canonical" ? (
                    <ResourceActionMenu
                      actionSubject={playerMediaActionSubject(model)}
                      label="Recording actions"
                      placement="above"
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
              )}

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
