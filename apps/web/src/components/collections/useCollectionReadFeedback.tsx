"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Failed } from "@/components/feedback/Fact";
import { Announcement } from "@/components/feedback/Announcement";
import { useActiveRegion } from "@/components/feedback/stage";
import type { ServerValue } from "@/lib/api/serverState";
import type { ServerList } from "@/lib/api/useServerList";
import type { PaneFilterRowsUnit } from "@/lib/panes/paneFilterRows";

/**
 * A list's continuation failure, for the host to place at the list's foot, and one outcome for a
 * host's announced first-read wait. The rows already loaded stay; `retry` reads `More` again, or
 * the list's own recovery after a rejected cursor. A same-query refresh failure renders nowhere.
 * Each wait belongs to its requested key; changing the key retires that wait. Inactivity retires
 * its episode for good. Only the host's `outcome` is spoken, from the active region alone, and
 * once: a region that goes quiet under a modal and speaks again never repeats it.
 */
export default function useCollectionReadFeedback({ list, unit, waiting, outcome }: {
  readonly list: ServerList<unknown, unknown>;
  readonly unit: PaneFilterRowsUnit;
  readonly waiting: boolean;
  readonly outcome: string | null;
}): { notice: ReactNode | null; announcement: ReactNode } {
  const { requestedKey, active, current, failure } = list;
  const announcement = useReadOutcome({ requestedKey, active, current, failed: failure !== null, waiting, outcome });
  const notice = failure?.op === "More"
    ? <Failed error={failure.error} noun={`more ${unit.plural}`} retry={{ run: list.retry, busy: list.running !== null }} />
    : null;
  return { notice, announcement };
}

/** One foreground wait/outcome; preparation, returns and passive reads are silent. Each outcome is
 * its own occurrence, which the live region delivers at most once. */
function useReadOutcome({ requestedKey, active, current, failed, waiting, outcome }: {
  readonly requestedKey: string | null;
  readonly active: boolean;
  readonly current: boolean;
  readonly failed: boolean;
  readonly waiting: boolean;
  readonly outcome: string | null;
}): ReactNode {
  const region = useActiveRegion();
  const episode = useRef({ key: requestedKey, waiting: false, armed: false });
  const [spoken, setSpoken] = useState<{ readonly text: string; readonly occurrence: object } | null>(null);
  useEffect(() => {
    const changedKey = requestedKey !== episode.current.key;
    const started = waiting && (changedKey || !episode.current.waiting);
    episode.current.key = requestedKey;
    episode.current.waiting = waiting;
    if (changedKey) {
      episode.current.armed = false;
      setSpoken(null);
    }
    if (requestedKey === null || !active || failed) {
      episode.current.armed = false;
      setSpoken(null);
      return;
    }
    if (current) {
      if (episode.current.armed) {
        episode.current.armed = false;
        setSpoken(outcome === null || outcome === "" ? null : { text: outcome, occurrence: {} });
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
  }, [requestedKey, waiting, active, current, failed, outcome]);

  return <Announcement text={spoken?.text ?? ""} occurrence={spoken?.occurrence} level={region ? "Polite" : "None"} />;
}

/** Complete-value outcome; a refresh failure over shown data renders nowhere and heals. */
export function useIndexReadFeedback({ value, requestedKey, active, waiting, outcome }: {
  readonly value: ServerValue<unknown>;
  readonly requestedKey: string | null;
  readonly active: boolean;
  readonly waiting: boolean;
  readonly outcome: string | null;
}): { announcement: ReactNode } {
  const error = value.status === "loading" ? null : value.error;
  const announcement = useReadOutcome({ requestedKey, active, current: value.status === "ready", failed: error !== null, waiting, outcome });
  return { announcement };
}
