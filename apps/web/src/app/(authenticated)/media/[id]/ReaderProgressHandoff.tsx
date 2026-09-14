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
  syncPending: boolean;
  sourceStatus: "ContentChanged" | "SourceUnavailable" | null;
  onAccept: () => void;
  onStay: () => void;
  onRetrySave: () => void;
  focusReaderViewport: () => void;
}

export default function ReaderProgressHandoff({
  handoff,
  announcement,
  saveFailed,
  syncPending,
  sourceStatus,
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
              disabled={handoff.busy || !handoff.canApply}
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
      {sourceStatus !== null && (
        <div role="status" className={styles.readerProgressSyncError}>
          {sourceStatus === "ContentChanged"
            ? "The saved position belongs to different or unknown content. It has not been applied here."
            : "The original source is unavailable. Its saved position has not been applied here."}
        </div>
      )}
      {syncPending && sourceStatus === null && (
        <div role="status" className={styles.readerProgressSyncError}>
          <span>Position saved on this device; sync is pending.</span>
          <button type="button" className={styles.readerProgressHandoffButton} onClick={onRetrySave}>Retry sync</button>
        </div>
      )}
      {saveFailed && (
        <div className={styles.readerProgressSyncError} data-testid="reader-progress-sync-error">
          <span>Position could not be saved. Keep this view open and retry.</span>
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
