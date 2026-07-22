"use client";

import { useId, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import { useWalknoteSession } from "@/lib/walknotes/walknoteSession";
import { formatTranscriptTimestampMs } from "@/lib/media/transcriptView";
import styles from "./WalknoteReviewPanel.module.css";

export default function WalknoteReviewPanel({
  onClose,
  returnFocusFallback,
  onMaterializeComplete,
}: {
  onClose: () => void;
  returnFocusFallback?: () => HTMLElement | null;
  onMaterializeComplete?: (created: number) => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const titleId = useId();

  const { waypoints, clearSession, materialize } = useWalknoteSession();

  // discardedIds: set of waypoint ids toggled to discard
  const [discardedIds, setDiscardedIds] = useState<Set<string>>(new Set());
  const [isMatching, setIsMatching] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const overlay = useDialogOverlay({
    ref: panelRef,
    active: true,
    onDismiss: onClose,
    initialFocus: () => titleRef.current,
    returnFocusFallback,
  });

  const toggleDiscard = (id: string) => {
    setDiscardedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const keptIds = waypoints
    .filter((w) => !discardedIds.has(w.id))
    .map((w) => w.id);

  const handleMaterialize = async () => {
    if (keptIds.length === 0) return;
    setIsMatching(true);
    try {
      const { created, errors } = await materialize(keptIds);
      onMaterializeComplete?.(created);
      if (errors.length > 0) {
        // Stay open so the user sees the partial-failure message
        setResultMessage(
          `${created} highlight${created === 1 ? "" : "s"} created, ${errors.length} position${errors.length === 1 ? "" : "s"} not found`
        );
      } else {
        onClose();
      }
    } catch {
      setResultMessage("Materialize failed");
    } finally {
      setIsMatching(false);
    }
  };

  const handleDiscardAll = () => {
    clearSession();
    onClose();
  };

  return (
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.overlay}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
        onClick={onClose}
      >
      <section
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 id={titleId} ref={titleRef} tabIndex={-1} className={styles.title}>
            Waypoints
          </h2>
          <Button
            variant="secondary"
            size="sm"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close waypoints panel"
          >
            Close
          </Button>
        </header>

        {waypoints.length === 0 ? (
          <p className={styles.empty}>No waypoints in this session.</p>
        ) : (
          <ul className={styles.waypointList} aria-label="Session waypoints">
            {waypoints.map((waypoint) => {
              const discarded = discardedIds.has(waypoint.id);
              const timestampLabel =
                formatTranscriptTimestampMs(waypoint.position_ms) ?? "0:00:00";

              return (
                <li
                  key={waypoint.id}
                  className={styles.waypointItem}
                  data-discarded={discarded ? "true" : "false"}
                >
                  <div className={styles.waypointContent}>
                    <div className={styles.timestamp}>{timestampLabel}</div>
                    {waypoint.voice_text !== null ? (
                      <div className={styles.voiceText}>{waypoint.voice_text}</div>
                    ) : waypoint.voice_status === "transcribing" ? (
                      <div className={styles.statusLabel}>Transcribing…</div>
                    ) : waypoint.voice_status === "failed" ? (
                      <div className={styles.statusLabel}>Failed to transcribe</div>
                    ) : (
                      <div className={styles.tapOnly}>(tap only)</div>
                    )}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.toggleButton}
                    aria-label={discarded ? `Keep waypoint at ${timestampLabel}` : `Discard waypoint at ${timestampLabel}`}
                    aria-pressed={discarded}
                    onClick={() => toggleDiscard(waypoint.id)}
                  >
                    {discarded ? "Keep" : "Discard"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {resultMessage && <p className={styles.resultText}>{resultMessage}</p>}

        <footer className={styles.footer}>
          <Button
            variant="primary"
            size="sm"
            className={styles.materializeButton}
            disabled={keptIds.length === 0 || isMatching}
            aria-label={`Materialize ${keptIds.length} waypoint${keptIds.length === 1 ? "" : "s"}`}
            onClick={() => void handleMaterialize()}
          >
            Materialize {keptIds.length}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className={styles.discardAllButton}
            aria-label="Discard all waypoints"
            onClick={handleDiscardAll}
          >
            Discard all
          </Button>
        </footer>
        </section>
      </div>
    </ModalLayerProvider>
  );
}
