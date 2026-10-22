"use client";

import { useEffect, useRef, useState } from "react";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import {
  paneCollectionRowsStatusMessage,
  paneFilterRowsStatusMessage,
  type PaneFilterRowsStatus as Status,
} from "@/lib/panes/paneFilterRows";
/** Visible counts; only subsequent user query changes are spoken after 400ms. */
export default function PaneFilterRowsStatus(props: {
  readonly status: Status;
  readonly query: string;
  readonly id: string;
}) {
  const { status, query } = props;
  const active = usePaneIsActive();
  const [announcement, setAnnouncement] = useState("");
  const lastQuery = useRef(query);
  const message = paneFilterRowsStatusMessage(status, query);
  const latestMessage = useRef(message);
  latestMessage.current = message;
  useEffect(() => {
    setAnnouncement("");
    const changed = lastQuery.current !== query;
    lastQuery.current = query;
    if (!changed || !active) return;
    const timeout = window.setTimeout(() => setAnnouncement(latestMessage.current), 400);
    return () => window.clearTimeout(timeout);
  }, [query, active]);
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
