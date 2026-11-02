"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { formatClock } from "@/lib/formatClock";
import * as Player from "@/lib/player/playerRuntime";
import styles from "./PlayerSeek.module.css";

const clock = (ms: number) => formatClock(ms / 1000);
const percent = (part: number, whole: number) =>
  `${whole > 0 ? (Math.min(part, whole) / whole) * 100 : 0}%`;

/** A captured scrub belongs to one confirmed load; cancellation never seeks. */
export default function PlayerSeek({ active }: { readonly active: boolean }) {
  const { positionMs, durationMs, bufferedMs } = Player.usePlayerTimeline();
  const { state, playbackSubject } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const scrub = useRef<{ readonly pointerId: number; readonly subject: string; value: number; cancelled: boolean } | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const available = active && state.kind === "Loaded" && playbackSubject !== null && durationMs > 0;
  useLayoutEffect(() => {
    if (scrub.current !== null) scrub.current.cancelled = true;
    setDraft(null);
  }, [playbackSubject, available]);
  useEffect(() => () => { scrub.current = null; }, []);
  const shown = Math.max(0, Math.min(draft ?? positionMs, durationMs));
  const track = {
    "--progress": percent(shown, durationMs),
    "--buffered": percent(Math.max(shown, bufferedMs), durationMs),
  } as CSSProperties;
  return <div className={styles.seek} style={track}>
    <span className={styles.time}>{state.kind === "Loaded" ? clock(shown) : "—"}</span>
    <span className={styles.track} aria-hidden="true" />
    <input type="range" className={styles.seekInput}
      min={0} max={durationMs} step={1000} value={shown} disabled={!available}
      aria-label="seek playback position" aria-valuetext={`${clock(shown)} of ${durationMs > 0 ? clock(durationMs) : "unknown duration"}`}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || !available || playbackSubject === null) return;
        scrub.current = { pointerId: event.pointerId, subject: playbackSubject, value: Number(event.currentTarget.value), cancelled: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={event => {
        const captured = scrub.current;
        if (captured?.pointerId !== event.pointerId) return;
        scrub.current = null;
        setDraft(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (available && !captured.cancelled && captured.subject === playbackSubject) commands.seekTo({ positionMs: captured.value, expectedSubject: captured.subject });
      }}
      onPointerCancel={event => {
        if (scrub.current?.pointerId === event.pointerId) scrub.current.cancelled = true;
        setDraft(null);
      }}
      onLostPointerCapture={event => {
        if (scrub.current?.pointerId === event.pointerId) scrub.current.cancelled = true;
        setDraft(null);
      }}
      onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
          scrub.current = null;
          setDraft(null);
        }
        // Native step rounding can leave the DOM at an endpoint already.
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          if (available && playbackSubject !== null) commands.seekTo({
            positionMs: event.key === "Home" ? 0 : durationMs,
            expectedSubject: playbackSubject,
          });
        }
      }}
      onChange={event => {
        const value = Number(event.currentTarget.value);
        if (scrub.current !== null) {
          if (!scrub.current.cancelled) { scrub.current.value = value; setDraft(value); }
        }
        else if (available && playbackSubject !== null) commands.seekTo({ positionMs: value, expectedSubject: playbackSubject });
      }}
    />
    <span className={styles.time}>{state.kind === "Loaded" && durationMs > 0 ? clock(durationMs) : "—"}</span>
  </div>;
}

/** A decorative edge of the mini; it never takes a row of its own. */
export function MiniProgress() {
  const { positionMs, durationMs } = Player.usePlayerTimeline();
  return (
    <span className={styles.miniProgress} aria-hidden="true">
      <span className={styles.miniFill} style={{ width: percent(positionMs, durationMs) }} />
    </span>
  );
}
