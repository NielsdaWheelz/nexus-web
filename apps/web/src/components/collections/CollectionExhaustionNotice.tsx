"use client";

import { useEffect, useRef, useState } from "react";
import { FeedbackStatus } from "@/components/feedback/Feedback";
import type { ServerList } from "@/lib/api/useServerList";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";

type Phase = "Idle" | "Draining" | "Stopped" | "Complete";

/** A drain's progress and continuation recovery remain at the end of its list. */
export default function CollectionExhaustionNotice({ list }: {
  readonly list: ServerList<unknown>;
}) {
  const active = usePaneIsActive();
  const failure = list.failure;
  const phase: Phase = !list.current
    ? "Idle"
    : list.complete
      ? "Complete"
      : failure === null
        ? "Draining"
        : failure.op === "More" ? "Stopped" : "Idle";
  const [text, action] = phase === "Draining"
    ? ["loading remaining items…", null]
    : phase !== "Stopped"
      ? [null, null]
      : failure?.error.code === "E_INVALID_CURSOR"
        ? ["this list can no longer continue", "refresh list"]
        : ["couldn’t load remaining items", "try again"];
  const previous = useRef<Phase>("Idle");
  const [announcement, setAnnouncement] = useState("");
  const count = list.items.length;
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (!active) return setAnnouncement("");
    if (phase === before) return;
    if (phase === "Complete") {
      setAnnouncement(before === "Draining" ? `finished loading ${count} ${count === 1 ? "item" : "items"}.` : "");
    } else setAnnouncement(action ? `${text}. ${action}.` : (text ?? ""));
  }, [phase, count, text, action, active]);
  return <>
    {text ? <FeedbackStatus
      content={{ tone: phase === "Stopped" ? "Warning" : "Neutral", title: text }}
      announcement="None"
      actions={action ? [{ label: action, busy: list.running !== null, onClick: list.retry }] : undefined}
    /> : null}
    <span className="sr-only" role="status" aria-atomic="true">{announcement}</span>
  </>;
}
