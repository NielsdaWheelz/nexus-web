"use client";

/**
 * Reader-local progress arbitration surface: the cross-device handoff and the
 * unresolved save-failure treatment. Non-modal, token-based, keyboard
 * operable. Announcement text lives in the polite live region; the buttons
 * live outside it. After either handoff button resolves, focus returns to the
 * stable reader viewport — automatic adoption never steals focus.
 */

import { useEffect, useRef } from "react";
import type { ReaderProgressHandoffState } from "@/lib/reader/useReaderProgress";
import styles from "./page.module.css";

interface ReaderProgressHandoffProps {
  handoff: ReaderProgressHandoffState | null;
  /** Polite auto-adoption announcement from the coordinator. */
  announcement: string;
  saveFailed: boolean;
  onAccept: () => void;
  onStay: () => void;
  onRetrySave: () => void;
  focusReaderViewport: () => void;
}

export default function ReaderProgressHandoff({
  handoff,
  announcement,
  saveFailed,
  onAccept,
  onStay,
  onRetrySave,
  focusReaderViewport,
}: ReaderProgressHandoffProps) {
  const resolvedByButtonRef = useRef(false);
  const hadHandoffRef = useRef(false);

  useEffect(() => {
    if (hadHandoffRef.current && handoff === null && resolvedByButtonRef.current) {
      focusReaderViewport();
    }
    hadHandoffRef.current = handoff !== null;
    if (handoff === null) {
      resolvedByButtonRef.current = false;
    }
  }, [focusReaderViewport, handoff]);

  const liveText = handoff !== null ? "More recent reading position available" : announcement;

  return (
    <>
      <div aria-live="polite" className={styles.readerProgressLiveRegion}>
        {liveText}
      </div>
      {handoff !== null && (
        <div
          role="group"
          aria-label="More recent reading position available"
          className={styles.readerProgressHandoff}
          data-testid="reader-progress-handoff"
        >
          <span className={styles.readerProgressHandoffTitle}>
            More recent reading position available
          </span>
          {(handoff.applyFailed || handoff.captureUnavailable) && (
            <span className={styles.readerProgressHandoffError}>
              {handoff.applyFailed
                ? "Couldn't go to that position. Retry."
                : "Couldn't read this position. Retry."}
            </span>
          )}
          <div className={styles.readerProgressHandoffActions}>
            <button
              type="button"
              className={styles.readerProgressHandoffButton}
              disabled={handoff.busy}
              onClick={() => {
                resolvedByButtonRef.current = true;
                onAccept();
              }}
            >
              Go to most recent position
            </button>
            <span aria-hidden="true" className={styles.readerProgressHandoffDivider}>
              ·
            </span>
            <button
              type="button"
              className={styles.readerProgressHandoffButton}
              disabled={handoff.busy}
              onClick={() => {
                resolvedByButtonRef.current = true;
                onStay();
              }}
            >
              Stay at this position
            </button>
          </div>
        </div>
      )}
      {saveFailed && (
        <div className={styles.readerProgressSyncError} data-testid="reader-progress-sync-error">
          <span>Progress not synced</span>
          <span aria-hidden="true" className={styles.readerProgressHandoffDivider}>
            ·
          </span>
          <button
            type="button"
            className={styles.readerProgressHandoffButton}
            onClick={onRetrySave}
          >
            Retry
          </button>
        </div>
      )}
    </>
  );
}
