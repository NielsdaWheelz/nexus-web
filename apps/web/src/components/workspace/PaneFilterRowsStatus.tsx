"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import {
  paneFilterRowsStatusMessage,
  type PaneFilterRowsStatus as Status,
} from "@/lib/panes/paneFilterRows";

const QUERY_ANNOUNCEMENT_DELAY_MS = 400;

/** Input description; only usable, active user-query changes are spoken. */
export default function PaneFilterRowsStatus(props: {
  readonly status: Status;
  readonly query: string;
  readonly id: string;
  readonly announceQueryChanges: boolean;
  readonly children?: ReactNode;
}) {
  const { status, query, announceQueryChanges } = props;
  const active = usePaneIsActive();
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const lastQuery = useRef(query);
  const message = paneFilterRowsStatusMessage(status, query);
  const permitted = announceQueryChanges && status.kind !== "Failed";
  const latestMessage = useRef<string | null>(null);
  latestMessage.current = permitted ? message : null;
  useEffect(() => {
    setAnnouncement(null);
    const changed = lastQuery.current !== query;
    lastQuery.current = query;
    if (!changed || !active || !permitted) return;
    const timeout = window.setTimeout(() => setAnnouncement(latestMessage.current), QUERY_ANNOUNCEMENT_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [query, active, permitted]);
  return (
    <>
      <span id={props.id}>
        {message}{props.children}
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
