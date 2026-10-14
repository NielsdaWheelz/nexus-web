"use client";

import { useEffect, useRef, useState } from "react";
import {
  paneCollectionRowsStatusMessage,
  paneFilterRowsStatusMessage,
  type PaneFilterRowsStatus as Status,
} from "@/lib/panes/paneFilterRows";
/** Visible counts, with settled changes spoken once after 400ms, never on mount. */
export default function PaneFilterRowsStatus(props: {
  readonly status: Status;
  readonly query: string;
  readonly id: string;
}) {
  const { status, query } = props;
  const [announcement, setAnnouncement] = useState("");
  const lastSettled = useRef<string | null>(null);
  const message = paneFilterRowsStatusMessage(status, query);
  useEffect(() => {
    setAnnouncement("");
    if (status.kind !== "Complete" || lastSettled.current === message) return;
    const first = lastSettled.current === null;
    lastSettled.current = message;
    if (first) return;
    const timeout = window.setTimeout(() => setAnnouncement(message), 400);
    return () => window.clearTimeout(timeout);
  }, [message, status.kind]);
  return (
    <>
      <span id={props.id} title={message}>
        {paneCollectionRowsStatusMessage(status, query)}
      </span>
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
