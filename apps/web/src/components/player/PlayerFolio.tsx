"use client";

import { useEffect, useRef, useState } from "react";
import { formatClock } from "@/lib/formatClock";
import { folioRest, type BarClock } from "@/lib/player/barModel";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import styles from "./PlayerFolio.module.css";

const time = (ms: number) => formatClock(ms / 1000);

/**
 * How long, in your time. Live, both forms render and css owns attention: the rest form changes on
 * the minute, the exact clock shows only while cold or scrubbing, or under the bar's pointer or its
 * rail's keyboard focus, so unattended playback never ticks seconds. At rest it is the summary's
 * minutes at 1×. Under 46rem the folio leaves and `Inline`, the rest form alone, leads line 2.
 * Decorative: the range carries the time.
 */
export default function PlayerFolio(props: { readonly clock: BarClock } & (
  | { readonly variant: "Bar"; readonly draft: number | null; readonly panelOpen: boolean }
  | { readonly variant: "Inline" }
)) {
  const { clock } = props;
  const { positionMs, durationMs } = Player.usePlayerTimeline();
  const { playbackSubject } = Player.usePlayerSession();
  const flash = useRateFlash(clock.kind === "Live" ? clock.loaded.rate : null, playbackSubject, props.variant === "Bar" && props.panelOpen);
  if (clock.kind === "Still") {
    const rest = clock.remainingMinutes === null ? null : folioRest(clock.remainingMinutes * 60_000, 1, false);
    return props.variant === "Bar" ? <span className={styles.folio} aria-hidden="true"><span>{rest}</span></span> : null;
  }
  const live = clock.loaded;
  // android reports no duration until media3 knows it; its descriptor does.
  const duration = durationMs > 0 ? durationMs : live.source.descriptor.duration_ms ?? 0;
  const rest = duration > 0 ? folioRest(duration - positionMs, live.rate, live.shortenPauses) : null;
  if (props.variant === "Inline") return rest === null ? null : <span aria-hidden="true">{rest} · </span>;
  const shown = props.draft ?? positionMs;
  const exact = duration > 0 ? `${time(Math.min(shown, duration))} / ${time(duration)}` : time(shown);
  return <span className={styles.folio} data-exact={clock.cold || props.draft !== null} aria-hidden="true">
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
