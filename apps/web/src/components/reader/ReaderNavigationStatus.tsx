"use client";

import { useEffect, useRef, useState } from "react";
import type { ReaderProgressHandoffState } from "@/lib/reader/useReaderProgress";
import styles from "./ReaderNavigationStatus.module.css";

export type ReaderNavigationStatusView =
  | { kind: "Reading"; error: string | null }
  | {
      kind: "Exploring";
      origin: "Held" | "Absent" | "Unavailable";
      originLabel: string | null;
      positioning: boolean;
      error: string | null;
    };

interface ReaderNavigationStatusProps {
  navigation: ReaderNavigationStatusView;
  handoff: ReaderProgressHandoffState | null;
  announcement: string;
  saveFailed: boolean;
  onReturn: () => void;
  onAdopt: () => boolean;
  onAcceptRemote: () => void;
  onKeepLocal: () => void;
  onRetrySave: () => void;
  focusReader: () => void;
}

/** One reader status area; the reader and remote cursor never compete for focus. */
export default function ReaderNavigationStatus({
  navigation,
  handoff,
  announcement,
  saveFailed,
  onReturn,
  onAdopt,
  onAcceptRemote,
  onKeepLocal,
  onRetrySave,
  focusReader,
}: ReaderNavigationStatusProps) {
  const exploring = navigation.kind === "Exploring";
  const [expanded, setExpanded] = useState<"navigation" | "remote" | null>(
    exploring ? "navigation" : handoff ? "remote" : null,
  );
  const previousExploring = useRef(exploring);
  const previousRemote = useRef(handoff !== null);
  const compactRef = useRef<HTMLButtonElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const remoteCompactRef = useRef<HTMLButtonElement | null>(null);
  const remoteFirstActionRef = useRef<HTMLButtonElement | null>(null);
  const remoteFocusReturnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (exploring && !previousExploring.current) setExpanded("navigation");
    else if (!exploring && previousExploring.current) setExpanded(handoff ? "remote" : null);
    previousExploring.current = exploring;
  }, [exploring, handoff]);
  useEffect(() => {
    if (handoff && !previousRemote.current && !exploring) setExpanded("remote");
    else if (!handoff && previousRemote.current && expanded === "remote") {
      setExpanded(exploring ? "navigation" : null);
      if (remoteFocusReturnRef.current) {
        const destination = remoteFocusReturnRef.current;
        requestAnimationFrame(() => destination.isConnected ? destination.focus({ preventScroll: true }) : focusReader());
        remoteFocusReturnRef.current = null;
      }
    }
    previousRemote.current = handoff !== null;
  }, [expanded, exploring, focusReader, handoff]);

  if (!exploring && handoff === null && !saveFailed && !announcement && !navigation.error) return null;
  const navigationTitle = exploring
    ? navigation.origin === "Unavailable"
      ? "reading spot unavailable"
      : navigation.origin === "Held"
        ? `reading spot held${navigation.originLabel ? ` · ${navigation.originLabel}` : ""}`
        : "inspecting this passage"
    : null;
  const navigationCompact = exploring
    ? navigation.origin === "Unavailable"
      ? "reading spot unavailable · options"
      : navigation.origin === "Held"
        ? "reading spot held"
        : "inspection · options"
    : null;
  const liveText = exploring
    ? `${navigationTitle}${navigation.error ? `. ${navigation.error}` : ""}${handoff ? ". newer reading spot available" : ""}`
    : handoff ? "newer reading spot available" : `${announcement}${navigation.error ? `. ${navigation.error}` : ""}`;

  return (
    <div className={styles.status} role="group" aria-label="reading position">
      <span className={styles.live} aria-live="polite">{liveText}</span>
      {exploring ? (
        expanded === "navigation" ? (
          <div className={styles.choice} role="group" aria-label="inspection options">
            <span className={styles.title}>{navigationTitle}</span>
            {navigation.error ? <span className={styles.error}>{navigation.error}</span> : null}
            {navigation.origin !== "Absent" ? (
              <button ref={navigation.origin === "Held" ? firstActionRef : undefined} type="button" className={styles.action} disabled={navigation.origin === "Unavailable"} onClick={onReturn}>
                back to your spot
              </button>
            ) : null}
            <button
              ref={navigation.origin === "Held" ? undefined : firstActionRef}
              type="button"
              className={styles.action}
              disabled={navigation.positioning}
              onClick={() => { if (onAdopt()) focusReader(); }}
            >
              continue reading here
            </button>
            <button
              type="button"
              className={styles.quietAction}
              onClick={() => {
                setExpanded(null);
                requestAnimationFrame(() => compactRef.current?.focus());
              }}
            >
              hide details
            </button>
          </div>
        ) : (
          <button
            ref={compactRef}
            type="button"
            className={styles.compact}
            onClick={() => {
              setExpanded("navigation");
              requestAnimationFrame(() => firstActionRef.current?.focus());
            }}
          >
            {navigationCompact}
          </button>
        )
      ) : null}
      {handoff ? (
        expanded === "remote" ? (
          <div className={styles.choice} role="group" aria-label="newer reading spot available">
            <span className={styles.title}>newer reading spot available</span>
            {handoff.applyFailed || handoff.captureUnavailable ? (
              <span className={styles.error}>
                {handoff.applyFailed ? "couldn't open that reading spot. try again." : "couldn't read this position. try again."}
              </span>
            ) : null}
            <button ref={remoteFirstActionRef} type="button" className={styles.action} disabled={handoff.busy} onClick={() => { remoteFocusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; onAcceptRemote(); }}>
              use newer spot
            </button>
            <button type="button" className={styles.action} disabled={handoff.busy} onClick={() => { remoteFocusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; onKeepLocal(); }}>
              {exploring && navigation.origin === "Absent" ? "keep inspecting" : "keep my reading spot"}
            </button>
            <button type="button" className={styles.quietAction} onClick={() => { setExpanded(null); requestAnimationFrame(() => remoteCompactRef.current?.focus()); }}>
              hide details
            </button>
          </div>
        ) : (
          <button ref={remoteCompactRef} type="button" className={styles.compact} onClick={() => { setExpanded("remote"); requestAnimationFrame(() => remoteFirstActionRef.current?.focus()); }}>
            newer reading spot available · review
          </button>
        )
      ) : null}
      {!exploring && navigation.error ? <span className={styles.error}>{navigation.error}</span> : null}
      {saveFailed ? (
        <div className={styles.syncError}>
          <span>progress not synced</span>
          <button type="button" className={styles.action} onClick={onRetrySave}>retry</button>
        </div>
      ) : null}
    </div>
  );
}
