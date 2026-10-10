"use client";

import { useEffect, useRef, useState } from "react";
import {
  paneCollectionRowsStatusMessage,
  paneFilterRowsStatusMessage,
  type PaneFilterRowsStatus as Status,
} from "@/lib/panes/paneFilterRows";
import styles from "./PaneCollectionBar.module.css";

/**
 * A filter's status under `id`. Visible (a collection row): terse text, and a
 * changed settled count spoken once after 400ms, never on mount. Hidden (the
 * filter row): the full sentence, spoken 160ms after the query changes.
 */
export default function PaneFilterRowsStatus(props: {
  readonly status: Status;
  readonly query: string;
  readonly id: string;
  readonly visible: boolean;
}) {
  const { status, query, visible } = props;
  const [announcement, setAnnouncement] = useState("");
  const lastSettled = useRef<string | null>(null);
  const message = paneFilterRowsStatusMessage(status, query);
  useEffect(() => {
    setAnnouncement("");
    if (visible) {
      if (status.kind !== "Complete" || lastSettled.current === message) return;
      const first = lastSettled.current === null;
      lastSettled.current = message;
      if (first) return;
    } else if (!query.trim()) return;
    const timeout = window.setTimeout(
      () => setAnnouncement(message),
      visible ? 400 : 160,
    );
    return () => window.clearTimeout(timeout);
  }, [message, query, status.kind, visible]);
  return (
    <>
      {visible ? (
        <span id={props.id} className={styles.status} title={message}>
          {paneCollectionRowsStatusMessage(status, query)}
        </span>
      ) : null}
      <span
        id={visible ? undefined : props.id}
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
