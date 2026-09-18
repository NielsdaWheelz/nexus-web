"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import type { ExhaustionState } from "@/lib/api/useExhaustivePagination";
import styles from "./CollectionExhaustionNotice.module.css";

interface Notice {
  readonly text: string;
  readonly action: { readonly label: string; readonly run: () => void } | null;
}

function noticeFor(state: ExhaustionState): Notice | null {
  switch (state.kind) {
    case "Idle":
    case "Complete":
      return null;
    case "Draining":
      return { text: "Loading remaining items…", action: null };
    case "ResumeFailed":
      return {
        text: "Could not finish loading",
        action: { label: "Retry", run: state.retry },
      };
    case "RefreshRequired":
      return {
        text:
          state.reason === "CollectionChanged"
            ? "List changed while loading"
            : "This list can no longer continue",
        action: { label: "Refresh list", run: state.refresh },
      };
  }
}

export default function CollectionExhaustionNotice({
  state,
}: {
  readonly state: ExhaustionState;
}) {
  const previousKindRef = useRef<ExhaustionState["kind"]>("Idle");
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const previousKind = previousKindRef.current;
    previousKindRef.current = state.kind;
    if (state.kind === previousKind) return;

    // Completion is the one announcement with no visible counterpart, and only
    // after a drain the reader was told about.
    if (state.kind === "Complete") {
      setAnnouncement(
        previousKind === "Draining"
          ? `Finished loading ${state.itemCount} ${state.itemCount === 1 ? "item" : "items"}.`
          : "",
      );
      return;
    }
    const notice = noticeFor(state);
    setAnnouncement(
      notice === null
        ? ""
        : notice.action === null
          ? notice.text
          : `${notice.text} — ${notice.action.label}`,
    );
  }, [state]);

  const notice = noticeFor(state);
  if (notice === null && announcement.length === 0) {
    return null;
  }

  return (
    <>
      {notice ? (
        <p className={styles.notice}>
          {notice.action ? (
            <>
              <span>{notice.text} —</span>
              <Button variant="ghost" size="sm" onClick={notice.action.run}>
                {notice.action.label}
              </Button>
            </>
          ) : (
            notice.text
          )}
        </p>
      ) : null}
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
    </>
  );
}
