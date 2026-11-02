"use client";

import type { Ref } from "react";
import Button from "@/components/ui/Button";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import styles from "./SpeedKey.module.css";

/**
 * The observed rate, and the way into playback settings. Settings need this load's subject:
 * until then the bar holds a disabled key and the sheet shows none.
 */
export default function SpeedKey({ ref, variant, expanded, controls, status, failed, busy, onToggle }: {
  readonly ref: Ref<HTMLButtonElement>;
  readonly variant: "Bar" | "Sheet";
  readonly expanded: boolean;
  readonly controls: string;
  readonly status: string | null;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
}) {
  const { state, preferences, playbackSubject } = Player.usePlayerSession();
  if (state.kind !== "Loaded" || preferences === null || playbackSubject === null)
    return variant === "Bar" ? <Button size="comfortable" className={styles.speed} aria-label="playback settings" disabled>speed</Button> : null;
  return <Button ref={ref} size="comfortable" className={styles.speed}
    aria-label={`playback settings, ${formatPlaybackRate(state.rate)}`} aria-description={status ?? undefined}
    aria-busy={preferences.application.kind === "Applying" || busy || undefined}
    aria-expanded={expanded} aria-controls={controls} aria-haspopup={variant === "Bar" ? "dialog" : undefined}
    onClick={onToggle}>
    {formatPlaybackRate(state.rate)}{status ? <span className={styles.marker} aria-hidden="true">{failed ? "!" : "·"}</span> : null}
  </Button>;
}
