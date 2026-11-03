"use client";

import { useEffect, useRef, useState } from "react";
import { assertNever } from "@/lib/assertNever";
import type { BarMode } from "@/lib/player/barModel";
import * as Player from "@/lib/player/playerRuntime";
import { unavailableMessages } from "./PlayerFailures";

type Phase = Extract<Player.PlayerState, { kind: "Loaded" }>["phase"];

/**
 * What the player's one live region says on its own, once each: a start, resume or new source, a
 * stop, the queue running out, and becoming unavailable; nothing on recovery. A playback failure the
 * queue already reports stays unsaid. `announce` lets the queue and the sheet speak through it.
 */
export function usePlayerAnnouncement(mode: BarMode): { readonly announcement: string | null; readonly announce: (message: string | null) => void } {
  const { state, queue } = Player.usePlayerSession();
  const [announcement, announce] = useState<string | null>(null);
  const announced = useRef<{ source: string | null; phase: Phase | null; unavailable: string | null; stopped: string | null }>({ source: null, phase: null, unavailable: null, stopped: null });
  const loaded = state.kind === "Loaded" ? state : null;
  const identity = loaded?.source.descriptor.media_id ?? null;
  const title = loaded?.source.descriptor.title;
  const queuePlaybackFailure = loaded !== null && loaded.playbackFailed
    && queue.failure?.kind === "Episode" && queue.failure.entry_id === queue.header?.current_entry_id;
  const unavailable = state.kind === "Unavailable" ? unavailableMessages[state.reason] : null;

  useEffect(() => {
    const said = announced.current;
    switch (state.kind) {
      case "Absent": {
        // the queue running out says so, in place of the stop it also is.
        const stop = mode.kind === "Finished" ? "queue finished" : "playback stopped";
        if (said.source !== null || said.stopped === "playback stopped" && stop === "queue finished") { announce(stop); said.stopped = stop; }
        said.source = null;
        said.phase = null;
        said.unavailable = null;
        break;
      }
      case "Unavailable":
        if (unavailable !== said.unavailable) announce(unavailable);
        said.unavailable = unavailable;
        break;
      case "Loaded": {
        said.stopped = null;
        if (queuePlaybackFailure) { said.source = identity; said.phase = state.phase; break; }
        const recovering = said.unavailable !== null;
        said.unavailable = null;
        const started = state.error === null && state.phase === "Playing";
        if (identity !== said.source) {
          const observation = started ? "now playing" : state.phase === "Buffering" ? "buffering" : "audio loaded";
          announce(state.error === null ? `${observation}: ${title}` : null);
        } else if (started && said.phase !== "Playing") announce(`now playing: ${title}`);
        else if (recovering) announce(null);
        said.source = identity;
        said.phase = state.phase;
        break;
      }
      default: assertNever(state);
    }
  }, [state, mode.kind, identity, title, unavailable, queuePlaybackFailure]);

  return { announcement, announce };
}
