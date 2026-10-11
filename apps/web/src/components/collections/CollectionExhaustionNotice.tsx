"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import type { ServerList } from "@/lib/api/useServerList";
import styles from "./CollectionExhaustionNotice.module.css";

type Phase = "Idle" | "Draining" | "Stopped" | "Complete";

/** The footer of a list that loads itself to the end (drain): progress, the
 * continuation failure with its recovery, and one sr-only completion line. */
export default function CollectionExhaustionNotice({
  list,
}: {
  readonly list: ServerList<unknown>;
}) {
  // Any failure stops the drain; only a failed continuation is this footer's to
  // show (the pane shows a failed load or reread).
  const failure = list.failure;
  const phase: Phase = !list.current
    ? "Idle"
    : list.complete
      ? "Complete"
      : failure === null
        ? "Draining"
        : failure.op === "More"
          ? "Stopped"
          : "Idle";
  const [text, action] =
    phase === "Draining"
      ? ["Loading remaining items…", null]
      : phase !== "Stopped"
        ? [null, null]
        : failure?.error.code === "E_INVALID_CURSOR"
          ? ["This list can no longer continue", "Refresh list"]
          : ["Could not finish loading", "Retry"];
  const previous = useRef<Phase>("Idle");
  const [announcement, setAnnouncement] = useState("");
  const count = list.items.length;
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (phase === before) return;
    // Completion has no visible counterpart: say it once, after a drain.
    if (phase === "Complete") {
      const items = count === 1 ? "item" : "items";
      setAnnouncement(
        before === "Draining" ? `Finished loading ${count} ${items}.` : "",
      );
    } else {
      setAnnouncement(action ? `${text} — ${action}` : (text ?? ""));
    }
  }, [phase, count, text, action]);

  if (text === null && announcement === "") return null;
  return (
    <>
      {text !== null ? (
        <p className={styles.notice}>
          {action ? (
            <>
              <span>{text} —</span>
              <Button variant="ghost" size="sm" onClick={list.retry}>
                {action}
              </Button>
            </>
          ) : (
            text
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
