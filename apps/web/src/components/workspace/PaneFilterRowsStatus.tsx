"use client";

import { useEffect, useState } from "react";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import { paneFilterRowsStatusMessage } from "@/lib/panes/paneFilterRows";
import styles from "./PaneCollectionBar.module.css";

const ANNOUNCEMENT_DEBOUNCE_MS = 160;

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
  const message = paneFilterRowsStatusMessage(status, query);
  useEffect(() => {
    setAnnouncement("");
    if (!query.trim()) {
      return;
    }
    const timeout = window.setTimeout(
      () => setAnnouncement(message),
      ANNOUNCEMENT_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [message, query]);

  return (
    <>
      {visible ? (
        <span id={id} className={styles.status} title={message}>
          {message}
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
