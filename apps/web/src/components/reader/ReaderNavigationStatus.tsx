"use client";

import { useEffect, useRef, useState } from "react";
import type { ReaderProgressHandoffState } from "@/lib/reader/useReaderProgress";
import type { ReaderCheckpoint, ReaderNavigation } from "@/lib/reader/useReaderNavigation";
import styles from "./ReaderNavigationStatus.module.css";

interface RemoteReadingSpot {
  handoff: ReaderProgressHandoffState | null;
  announcement: string;
  saveFailed: boolean;
  onAccept: () => void;
  onStay: () => void;
  onRetrySave: () => void;
}

export default function ReaderNavigationStatus({
  navigation,
  originLabel,
  remote,
  focusReader,
  focusReturn,
  onAdopt,
}: {
  navigation: ReaderNavigation;
  originLabel?: string | null;
  remote?: RemoteReadingSpot;
  focusReader?: () => void;
  focusReturn?: (origin: ReaderCheckpoint) => void;
  onAdopt?: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [panel, setPanel] = useState<"Inspection" | "Remote">("Inspection");
  const compactRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const focusAfterRender = useRef<"Compact" | "Expanded" | null>(null);
  const remoteChoiceRef = useRef(false);
  const hadRemoteRef = useRef(false);
  const exploring = navigation.state.kind === "Exploring" ? navigation.state : null;
  const remoteHandoff = remote?.handoff ?? null;
  const error = navigation.state.error;

  useEffect(() => {
    if (focusAfterRender.current === "Compact") compactRef.current?.focus();
    if (focusAfterRender.current === "Expanded") firstActionRef.current?.focus();
    focusAfterRender.current = null;
  }, [detailsOpen, panel]);

  useEffect(() => {
    if (hadRemoteRef.current && remoteHandoff === null && remoteChoiceRef.current) focusReader?.();
    hadRemoteRef.current = remoteHandoff !== null;
    if (remoteHandoff === null) remoteChoiceRef.current = false;
  }, [focusReader, remoteHandoff]);

  if (!exploring && !remoteHandoff && !remote?.saveFailed && !error) return null;

  const originAvailable = exploring?.origin.kind === "Present" && !exploring.originUnavailable;
  const inspectionTitle = exploring?.originUnavailable
    ? "reading spot unavailable"
    : exploring?.origin.kind === "Present"
      ? "reading spot held"
      : "inspecting this passage";
  const compactLabel = exploring?.originUnavailable
    ? "reading spot unavailable · options"
    : exploring?.origin.kind === "Present"
      ? "reading spot held · options"
      : "inspection · options";
  const showRemote = remoteHandoff !== null && (panel === "Remote" || !exploring);
  const message = error?.outcome.kind === "Unavailable"
    ? exploring?.originUnavailable || (error.action === "Return" && error.outcome.reason === "SourceChanged")
      ? "your reading spot is unavailable in this version."
      : error.action === "Adopt"
        ? "couldn't use this reading position. try again."
        : error.action === "Return"
          ? "couldn't return to your spot. try again."
          : error.outcome.reason === "CaptureUnavailable"
            ? "couldn't hold your reading spot. try again."
            : "couldn't open that passage."
    : null;

  return (
    <section className={styles.status} aria-label="reading position">
      <span className={styles.announcement} aria-live="polite">
        {exploring?.originUnavailable ? "your reading spot is unavailable in this version." :
          remoteHandoff ? "newer reading spot available" :
            exploring ? inspectionTitle : remote?.announcement ?? ""}
      </span>
      {!detailsOpen ? (
        <button ref={compactRef} type="button" className={styles.compact} onClick={() => {
          setDetailsOpen(true);
          focusAfterRender.current = "Expanded";
        }}>
          {remoteHandoff && !exploring ? "newer reading spot available · review" : compactLabel}
        </button>
      ) : (
        <div className={styles.details}>
          {exploring && remoteHandoff ? (
            <div className={styles.switcher} aria-label="reading position choices">
              <button type="button" aria-pressed={!showRemote} onClick={() => setPanel("Inspection")}>inspection</button>
              <button type="button" aria-pressed={showRemote} onClick={() => setPanel("Remote")}>newer spot</button>
            </div>
          ) : null}
          {showRemote && remoteHandoff ? (
            <div className={styles.choice} role="group" aria-label="newer reading spot available">
              <span>newer reading spot available</span>
              {remoteHandoff.applyFailed || remoteHandoff.captureUnavailable ? (
                <span className={styles.error}>{remoteHandoff.applyFailed ? "couldn't open that passage. try again." : "couldn't hold your reading spot. try again."}</span>
              ) : null}
              <button ref={firstActionRef} type="button" disabled={remoteHandoff.busy} onClick={() => {
                remoteChoiceRef.current = true;
                remote?.onAccept();
              }}>use newer spot</button>
              <button type="button" disabled={remoteHandoff.busy} onClick={() => {
                remoteChoiceRef.current = true;
                remote?.onStay();
              }}>{exploring?.origin.kind === "Absent" ? "keep inspecting" : "keep my reading spot"}</button>
            </div>
          ) : exploring ? (
            <div className={styles.choice} role="group" aria-label="inspection choices">
              <span>{inspectionTitle}{originAvailable && originLabel ? ` · ${originLabel}` : ""}</span>
              {message ? <span className={styles.error} role="status">{message}</span> : null}
              {exploring.origin.kind === "Present" ? (
                <button ref={firstActionRef} type="button" disabled={!originAvailable} onClick={() => {
                  if (exploring.origin.kind !== "Present") return;
                  const origin = exploring.origin.value;
                  void navigation.returnToOrigin().then((outcome) => {
                    if (outcome.kind === "Arrived" || outcome.kind === "Unchanged") {
                      if (focusReturn) focusReturn(origin);
                      else focusReader?.();
                    }
                  });
                }}>back to your spot</button>
              ) : null}
              <button ref={exploring.origin.kind === "Absent" ? firstActionRef : undefined} type="button" disabled={exploring.busy} onClick={() => {
                const outcome = navigation.adoptHere();
                if (outcome.kind === "Arrived") {
                  onAdopt?.();
                  focusReader?.();
                }
              }}>continue reading here</button>
            </div>
          ) : message ? <span className={styles.error} role="status">{message}</span> : null}
          {remote?.saveFailed ? (
            <div className={styles.syncError}><span>progress not synced</span><button type="button" onClick={remote.onRetrySave}>retry</button></div>
          ) : null}
          <button type="button" className={styles.quiet} onClick={() => {
            focusAfterRender.current = "Compact";
            setDetailsOpen(false);
          }}>hide details</button>
        </div>
      )}
    </section>
  );
}
