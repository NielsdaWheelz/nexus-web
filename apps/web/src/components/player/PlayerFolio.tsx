"use client";

import { useEffect, useRef, useState } from "react";
import { formatClock } from "@/lib/formatClock";
import { folioRest, type BarClock } from "@/lib/player/barModel";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import styles from "./PlayerFolio.module.css";

const REST_SAMPLE_MS = 60_000;
const RATE_FLASH_MS = 1200;
const time = (ms: number) => formatClock(ms / 1000);

/**
 * Warm rest publishes at most once a real minute between subject/rate/mode transitions. A warm
 * seek without a draft may leave the previous sample until then; silence skipping is not a seek
 * signal. Cold observations and exact attended time stay live. All forms are decorative: the rail
 * owns time speech.
 */
export default function PlayerFolio(props: { readonly clock: BarClock } & (
  | { readonly variant: "Bar"; readonly draft: number | null; readonly panelOpen: boolean }
  | { readonly variant: "Inline" }
)) {
  const { clock } = props;
  const { positionMs, durationMs } = Player.usePlayerTimeline();
  const { playbackSubject } = Player.usePlayerSession();
  const live = clock.kind === "Live" ? clock.loaded : null;
  const flash = useRateFlash(props.variant === "Bar" ? live?.rate ?? null : null, playbackSubject, props.variant === "Bar" && props.panelOpen);
  // android reports no duration until media3 knows it; its descriptor does.
  const duration = live === null ? 0 : durationMs > 0 ? durationMs : live.source.descriptor.duration_ms ?? 0;
  const drafting = props.variant === "Bar" && props.draft !== null;
  const sample = useRef<{
    subject: string | null; rate: number; skip: boolean; cold: boolean; known: boolean;
    drafting: boolean; at: number; rest: string | null;
  } | null>(null);
  if (live === null) sample.current = null;
  else {
    const before = sample.current;
    const now = performance.now();
    if (clock.cold || before === null || before.subject !== playbackSubject || before.rate !== live.rate || before.skip !== live.shortenPauses ||
      before.cold !== clock.cold || before.known !== (duration > 0) || before.drafting !== drafting || now - before.at >= REST_SAMPLE_MS) {
      sample.current = { subject: playbackSubject, rate: live.rate, skip: live.shortenPauses, cold: clock.cold,
        known: duration > 0, drafting, at: now, rest: duration > 0 ? folioRest(duration - positionMs, live.rate, live.shortenPauses) : null };
    }
  }
  if (clock.kind === "Still") {
    const rest = clock.remainingMinutes === null ? null : folioRest(clock.remainingMinutes * 60_000, 1, false);
    return props.variant === "Bar" ? <span className={styles.folio} aria-hidden="true"><span>{rest}</span></span> : null;
  }
  const rest = sample.current?.rest ?? null;
  if (props.variant === "Inline") return rest === null ? null : <span aria-hidden="true">{rest} · </span>;
  const shown = props.draft ?? positionMs;
  const exact = duration > 0 ? `${time(Math.min(shown, duration))} / ${time(duration)}` : time(shown);
  return <span className={styles.folio} data-exact={clock.cold || drafting} aria-hidden="true">
    {flash !== null && !drafting ? <span>{flash}</span> : <>
      <span className={styles.rest}>{rest}</span>
      <span className={styles.exact}>{exact}</span>
    </>}
  </span>;
}

/** Only a same-subject observed change flashes; a new load and an open panel retire it. */
function useRateFlash(rate: number | null, subject: string | null, panelOpen: boolean): string | null {
  const [flash, setFlash] = useState<{ readonly rate: number; readonly subject: string; readonly text: string } | null>(null);
  const seen = useRef({ rate, subject });
  useEffect(() => {
    const before = seen.current;
    seen.current = { rate, subject };
    if (rate === null || subject === null || before.subject !== subject || panelOpen) { setFlash(null); return; }
    if (before.rate !== null && before.rate !== rate) setFlash({ rate, subject, text: `speed ${formatPlaybackRate(rate)}` });
  }, [rate, subject, panelOpen]);
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), RATE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);
  return !panelOpen && flash?.subject === subject && flash.rate === rate ? flash.text : null;
}
