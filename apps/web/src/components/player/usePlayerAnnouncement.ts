"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { assertNever } from "@/lib/assertNever";
import type { BarMode } from "@/lib/player/barModel";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import { unavailableMessages } from "@/lib/player/barModel";

type Phase = Extract<Player.PlayerState, { kind: "Loaded" }>["phase"];
type PlayerAnnouncement = { readonly text: string; readonly occurrence: object } & (
  | { readonly kind: "Playback" }
  | { readonly kind: "Rate"; readonly subject: string; readonly label: string }
);

/**
 * What the player's one live region says on its own, once each: a start, resume or new source, a
 * stop, the queue running out, and becoming unavailable; nothing on recovery. A playback failure the
 * queue already reports stays unsaid. Each onset has a fresh speech identity.
 */
export function usePlayerAnnouncement(mode: BarMode) {
  const { state, queue, preferences, playbackSubject } = Player.usePlayerSession();
  const [announcement, setAnnouncement] = useState<PlayerAnnouncement | null>(null);
  const announce = useCallback((text: string | null) => setAnnouncement(text === null ? null : { kind: "Playback", text, occurrence: {} }), []);
  const announced = useRef<{ source: string | null; phase: Phase | null; unavailable: string | null; stopped: string | null }>({ source: null, phase: null, unavailable: null, stopped: null });
  const loaded = state.kind === "Loaded" ? state : null;
  const identity = loaded?.source.descriptor.media_id ?? null;
  const title = loaded?.source.descriptor.title;
  const queuePlaybackFailure = loaded !== null && loaded.playbackFailed
    && queue.error?.kind === "Episode" && queue.error.entry_id === queue.header?.current_entry_id;
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
        const started = !state.playbackFailed && state.phase === "Playing";
        if (identity !== said.source) {
          const observation = started ? "now playing" : state.phase === "Buffering" ? "buffering" : "audio loaded";
          announce(!state.playbackFailed ? `${observation}: ${title}` : null);
        } else if (started && said.phase !== "Playing") announce(`now playing: ${title}`);
        else if (recovering) announce(null);
        said.source = identity;
        said.phase = state.phase;
        break;
      }
      default: assertNever(state);
    }
  }, [state, mode.kind, identity, title, unavailable, queuePlaybackFailure, announce]);

  const readyRate = useRef<{ subject: string | null; label: string | null }>({ subject: null, label: null });
  useEffect(() => {
    if (readyRate.current.subject !== playbackSubject) readyRate.current = { subject: playbackSubject, label: null };
    if (playbackSubject === null || state.kind !== "Loaded" || preferences?.application.kind !== "Ready") return;
    const label = formatPlaybackRate(state.rate);
    const previous = readyRate.current.label;
    readyRate.current.label = label;
    if (previous !== null && previous !== label)
      setAnnouncement({ kind: "Rate", text: `speed ${label}`, occurrence: {}, subject: playbackSubject, label });
  }, [playbackSubject, state, preferences]);

  // keep queued rate speech tied to the current ready observation through publication.
  const deferred = announcement?.kind === "Rate" && (state.kind !== "Loaded"
    || playbackSubject !== announcement.subject || preferences?.application.kind !== "Ready"
    || formatPlaybackRate(state.rate) !== announcement.label);
  return { announcement, deferred };
}
