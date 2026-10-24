"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { ServerList } from "@/lib/api/useServerList";
import type { PaneFilterRowsUnit } from "@/lib/panes/paneFilterRows";

/**
 * Continuation recovery and one outcome for a host's announced first-read wait.
 * Each wait belongs to its requested key; changing the key retires that wait.
 * Waiting is independent of activity; inactivity retires its episode permanently.
 * The host supplies truthful rendered-row outcomes and mounts the live node outside
 * optional footers. Passive traversal and same-query refresh never announce here.
 */
export default function useCollectionReadFeedback({ list, unit, waiting, outcome, returnFocus }: {
  readonly list: ServerList<unknown, unknown>;
  readonly unit: PaneFilterRowsUnit;
  readonly waiting: boolean;
  readonly outcome: string | null;
  readonly returnFocus: () => HTMLElement | null;
}): { notice: ReactNode | null; announcement: ReactNode } {
  const { requestedKey, active, current, failure } = list;
  const episode = useRef({ key: requestedKey, waiting: false, armed: false });
  const [spoken, setSpoken] = useState<string | null>(null);
  useEffect(() => {
    const changedKey = requestedKey !== episode.current.key;
    const started = waiting && (changedKey || !episode.current.waiting);
    episode.current.key = requestedKey;
    episode.current.waiting = waiting;
    if (changedKey) {
      episode.current.armed = false;
      setSpoken(null);
    }
    if (requestedKey === null || !active || failure !== null) {
      episode.current.armed = false;
      setSpoken(null);
      return;
    }
    if (current) {
      if (episode.current.armed) {
        episode.current.armed = false;
        setSpoken(outcome);
      }
      return;
    }
    if (!waiting) {
      episode.current.armed = false;
      setSpoken(null);
      return;
    }
    if (started) {
      episode.current.armed = true;
      setSpoken(null);
    }
  }, [requestedKey, waiting, active, current, failure, outcome]);

  const continuationFailure = failure?.op === "More" ? failure : null;
  const rejected = continuationFailure?.error.code === "E_INVALID_CURSOR";
  const notice = continuationFailure === null ? null : <FeedbackNotice
    content={{
      tone: "Warning",
      title: rejected ? `couldn’t continue loading ${unit.plural}` : `couldn’t load remaining ${unit.plural}`,
      message: `the ${unit.plural} already loaded are still available.`,
      requestId: continuationFailure.error.requestId,
    }}
    announcement={active ? "Polite" : "None"}
    actions={[{ label: rejected ? "refresh list" : "try again", busy: list.running !== null, onClick: list.retry }]}
    returnFocus={returnFocus}
  />;
  return {
    notice,
    announcement: <span className="sr-only" role="status" aria-live={active ? "polite" : "off"} aria-atomic="true">{spoken}</span>,
  };
}
