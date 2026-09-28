"use client";

import { useEffect, useRef, useState } from "react";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import { paneCollectionRowsStatusMessage, paneFilterRowsStatusMessage } from "@/lib/panes/paneFilterRows";
import styles from "./PaneCollectionBar.module.css";

const ANNOUNCEMENT_DEBOUNCE_MS = 160;
const COLLECTION_ANNOUNCEMENT_DEBOUNCE_MS = 400;

export default function PaneFilterRowsStatus({
  status,
  query,
  id,
  visible,
}: {
  readonly status: PaneFilterRowsStatus;
  readonly query: string;
  readonly id: string;
  readonly visible: boolean;
}) {
  const [announcement, setAnnouncement] = useState("");
  const lastSettledMessage = useRef<string | null>(null);
  const message = paneFilterRowsStatusMessage(status, query);
  const visualMessage = visible
    ? paneCollectionRowsStatusMessage(status, query)
    : message;
  useEffect(() => {
    setAnnouncement("");
    if (visible) {
      if (status.kind !== "Complete") return;
      if (lastSettledMessage.current === null) {
        lastSettledMessage.current = message;
        return;
      }
      if (lastSettledMessage.current === message) return;
      lastSettledMessage.current = message;
      const timeout = window.setTimeout(
        () => setAnnouncement(message),
        COLLECTION_ANNOUNCEMENT_DEBOUNCE_MS,
      );
      return () => window.clearTimeout(timeout);
    }
    if (!query.trim()) return;
    const timeout = window.setTimeout(
      () => setAnnouncement(message),
      ANNOUNCEMENT_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [message, query, status.kind, visible]);

  return (
    <>
      {visible ? (
        <span id={id} className={styles.status} title={message}>
          {visualMessage}
        </span>
      ) : null}
      <span
        id={visible ? undefined : id}
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
