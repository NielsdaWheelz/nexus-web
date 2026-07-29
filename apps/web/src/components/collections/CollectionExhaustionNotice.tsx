"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import type { ExhaustionState } from "@/lib/api/useExhaustivePagination";
import styles from "./CollectionExhaustionNotice.module.css";

function completionAnnouncement(itemCount: number): string {
  return `Finished loading ${itemCount} ${itemCount === 1 ? "item" : "items"}.`;
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

    switch (state.kind) {
      case "Idle":
        setAnnouncement("");
        return;
      case "Draining":
        setAnnouncement("Loading remaining items…");
        return;
      case "Complete":
        setAnnouncement(
          previousKind === "Draining"
            ? completionAnnouncement(state.itemCount)
            : "",
        );
        return;
      case "ResumeFailed":
        setAnnouncement("Could not finish loading — Retry");
        return;
      case "RefreshRequired":
        setAnnouncement(
          state.reason === "CollectionChanged"
            ? "List changed while loading — Refresh list"
            : "This list can no longer continue — Refresh list",
        );
        return;
    }
  }, [state]);

  const notice = (() => {
    switch (state.kind) {
      case "Idle":
      case "Complete":
        return null;
      case "Draining":
        return <p className={styles.notice}>Loading remaining items…</p>;
      case "ResumeFailed":
        return (
          <p className={styles.notice}>
            <span>Could not finish loading —</span>
            <Button variant="ghost" size="sm" onClick={state.retry}>
              Retry
            </Button>
          </p>
        );
      case "RefreshRequired":
        return (
          <p className={styles.notice}>
            <span>
              {state.reason === "CollectionChanged"
                ? "List changed while loading —"
                : "This list can no longer continue —"}
            </span>
            <Button variant="ghost" size="sm" onClick={state.refresh}>
              Refresh list
            </Button>
          </p>
        );
    }
  })();

  if (notice === null && announcement.length === 0) {
    return null;
  }

  return (
    <>
      {notice}
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
