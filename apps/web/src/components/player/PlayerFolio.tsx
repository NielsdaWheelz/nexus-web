"use client";

import { useEffect, useRef, useState } from "react";
import { formatClock } from "@/lib/formatClock";
import { folioRest, type BarClock } from "@/lib/player/barModel";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import styles from "./PlayerFolio.module.css";

const clock = (ms: number) => formatClock(ms / 1000);

/**
 * How long, in your time. Live, both forms render and css owns attention: the rest form changes on
 * the minute, the exact clock shows only under the bar's pointer, its rail's keyboard focus, a scrub
 * or a still phase, so unattended playback never ticks seconds. At rest it is the summary's minutes
 * at 1×. `Inline` is the rest form alone, leading line 2. Decorative: the range carries the time.
 */
export default function PlayerFolio(props: { readonly clock: BarClock } & (
  | { readonly variant: "Bar"; readonly draft: number | null; readonly panelOpen: boolean }
  | { readonly variant: "Inline" }
)) {
  const { positionMs, durationMs } = Player.usePlayerTimeline();
  const { playbackSubject } = Player.usePlayerSession();
  const live = props.clock.kind === "Live" ? props.clock.loaded : null;
  const flash = useRateFlash(live?.rate ?? null, playbackSubject, props.variant === "Bar" && props.panelOpen);
  if (live === null) {
    const minutes = props.clock.kind === "Still" ? props.clock.remainingMinutes : null;
    // a finished cursor replays from 0, so `0m left` would contradict the next press.
    const rest = minutes !== null && minutes > 0 ? folioRest(minutes * 60_000, 1, false) : null;
    return props.variant === "Bar" ? <span className={styles.folio} aria-hidden="true"><span>{rest}</span></span> : null;
  }
  // android reports no duration until media3 knows it; its descriptor does.
  const duration = durationMs > 0 ? durationMs : live.source.descriptor.duration_ms ?? 0;
  const rest = duration > 0 ? folioRest(duration - positionMs, live.rate, live.shortenPauses) : null;
  if (props.variant === "Inline") return rest === null ? null : <span aria-hidden="true">{rest} · </span>;
  const shown = props.draft ?? positionMs;
  const exact = duration > 0 ? `${clock(Math.min(shown, duration))} / ${clock(duration)}` : clock(shown);
  return <span className={styles.folio} aria-hidden="true">
    {flash !== null && props.draft === null ? <span>{flash}</span> : <>
      <span className={styles.rest}>{rest}</span>
      <span className={styles.exact}>{exact}</span>
    </>}
  </span>;
}

/** A same-subject change of the observed rate prints for 1200ms while the panel is closed; a load,
 * which starts a new subject, never does. */
function useRateFlash(rate: number | null, subject: string | null, panelOpen: boolean): string | null {
  const [flash, setFlash] = useState<{ readonly text: string } | null>(null);
  const seen = useRef<{ readonly rate: number | null; readonly subject: string | null }>({ rate, subject });
  useEffect(() => {
    const before = seen.current;
    seen.current = { rate, subject };
    if (rate === null || subject === null || before.subject !== subject || before.rate === rate || panelOpen) return;
    setFlash({ text: `speed ${formatPlaybackRate(rate)}` });
  }, [rate, subject, panelOpen]);
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(timer);
  }, [flash]);
  return flash?.text ?? null;
}
