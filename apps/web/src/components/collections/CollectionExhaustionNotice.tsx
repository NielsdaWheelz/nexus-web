"use client";

import { useEffect, useRef, useState } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import type { ServerList } from "@/lib/api/useServerList";
import type { PaneFilterRowsUnit } from "@/lib/panes/paneFilterRows";

type Phase = "Idle" | "Initial" | "Loading" | "Paused" | "Failed" | "Complete";

/** Traversal owns progress and recovery speech; filtering owns only user changes. */
export default function CollectionExhaustionNotice({ list, unit, returnFocus }: {
  readonly list: ServerList<unknown, unknown>;
  readonly unit: PaneFilterRowsUnit;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const failure = list.failure?.op === "More" ? list.failure : null;
  const phase: Phase = !list.current
    ? "Initial"
    : failure !== null
      ? "Failed"
      : list.complete
        ? "Complete"
        : list.failure !== null
          ? "Idle"
          : list.running !== null || list.active ? "Loading" : "Paused";
  const rejected = failure?.error.code === "E_INVALID_CURSOR";
  const title = phase === "Loading"
    ? `loading remaining ${unit.plural}…`
    : phase === "Paused"
      ? "loading paused"
      : phase === "Failed"
        ? rejected ? `couldn’t continue loading ${unit.plural}` : `couldn’t load remaining ${unit.plural}`
        : "";
  const action = rejected ? "refresh list" : "try again";
  const previous = useRef<{ phase: Phase; active: boolean }>({ phase: "Idle", active: false });
  const traversing = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const count = list.items.length;
  useEffect(() => {
    const before = previous.current;
    previous.current = { phase, active: list.active };
    if (phase === "Initial") traversing.current = list.active;
    if (phase === "Loading" && list.active && list.running !== "Refetch") traversing.current = true;
    if (phase === "Complete") {
      if (before.phase === "Complete") {
        if (!list.active) setAnnouncement("");
        return;
      }
      const finished = traversing.current;
      traversing.current = false;
      setAnnouncement(list.active && finished ? `finished loading ${count} ${count === 1 ? unit.singular : unit.plural}.` : "");
      return;
    }
    if (!list.active) return setAnnouncement("");
    if (before.phase === phase && before.active) return;
    setAnnouncement(phase === "Failed" ? `${title}. ${action}.` : title);
  }, [phase, count, title, action, list.active, list.running, unit.singular, unit.plural]);
  return <>
    {phase === "Failed" && failure !== null ? <FeedbackNotice
      content={{
        tone: "Warning", title, requestId: failure.error.requestId,
        message: rejected ? undefined : `the ${unit.plural} already loaded are still available.`,
      }}
      announcement="None"
      actions={[{ label: action, busy: list.running !== null, onClick: list.retry }]}
      returnFocus={returnFocus}
    /> : title !== "" ? <FeedbackStatus
      content={{ tone: "Neutral", title, message: phase === "Paused" ? `return to this view to load the remaining ${unit.plural}.` : undefined }}
      announcement="None"
    /> : null}
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </>;
}
