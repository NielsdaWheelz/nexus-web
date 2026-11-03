"use client";

import { useCallback, useRef, type Ref } from "react";
import Button from "@/components/ui/Button";
import { presentPlaybackRate, stepRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import { cx } from "@/lib/ui/cx";
import * as Icon from "@/lib/ui/icons";
import styles from "./SpeedKey.module.css";

const WHEEL_DWELL_MS = 150;
const WHEEL_STEP_PX = 40;

/** The observed dial; admission comes from the same live keys as transport. */
export default function SpeedKey({ ref, variant, availability, expanded, controls, status, failed, busy, onToggle }: {
  readonly ref: Ref<HTMLButtonElement>;
  readonly variant: "Bar" | "Sheet";
  readonly availability: "Enabled" | "Disabled" | null;
  readonly expanded: boolean;
  readonly controls: string;
  readonly status: string | null;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
}) {
  const { state, preferences } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const latest = useRef({ availability, preferences, commands });
  latest.current = { availability, preferences, commands };
  const hover = useRef<{ entered: number; pixels: number } | null>(null);
  // A native non-passive listener owns this wheel; React's delegated wheel cannot cancel scrolling.
  const attach = useCallback((element: HTMLButtonElement | null) => {
    const release = typeof ref === "function" ? ref(element) : undefined;
    if (typeof ref !== "function" && ref !== null) ref.current = element;
    if (element === null) return;
    const wheel = (event: WheelEvent) => {
      const current = latest.current;
      const dwell = hover.current;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !matchMedia("(hover: hover) and (pointer: fine)").matches || current.availability !== "Enabled" ||
        current.preferences === null || dwell === null || performance.now() - dwell.entered < WHEEL_DWELL_MS) return;
      const pixels = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? Number.parseFloat(getComputedStyle(element).lineHeight)
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1);
      if (pixels === 0) return;
      event.preventDefault();
      dwell.pixels += pixels;
      let rate = current.preferences.rate;
      while (Math.abs(dwell.pixels) >= WHEEL_STEP_PX) {
        const direction = dwell.pixels < 0 ? 1 : -1;
        dwell.pixels += direction * WHEEL_STEP_PX;
        const next = stepRate(rate, direction);
        if (next !== null) rate = next;
      }
      if (rate !== current.preferences.rate) current.commands.setPlaybackRate(rate);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      hover.current = null;
      if (typeof release === "function") release();
      else if (typeof ref === "function") ref(null);
      else if (ref !== null) ref.current = null;
    };
  }, [ref]);
  const shown = presentPlaybackRate(state.kind === "Loaded" ? state.rate : 1);
  const waiting = preferences?.application.kind === "Applying" || busy;
  return <Button ref={attach} size="comfortable" className={cx(styles.speed, availability === null && styles.absent)}
    aria-label={`${variant === "Bar" ? "playback settings" : "speed"}, ${shown.label}`}
    tooltip={{ text: `speed ${shown.label}` }} aria-description={status ?? undefined}
    aria-disabled={availability === "Disabled" || undefined} tabIndex={availability === null ? -1 : undefined}
    aria-busy={waiting || undefined} aria-expanded={expanded} aria-controls={controls}
    aria-haspopup={variant === "Bar" ? "dialog" : undefined} onClick={onToggle}
    onPointerEnter={event => { hover.current = event.pointerType === "mouse" ? { entered: performance.now(), pixels: 0 } : null; }}
    onPointerLeave={() => { hover.current = null; }}>
    <span className={styles.face}><span aria-hidden="true"><Icon.Speed size={24} rate={shown.rate} /></span>{variant === "Sheet" ? "speed" : null}</span>
    {status !== null || waiting ? <span className={cx(styles.marker, failed && styles.failed)} aria-hidden="true" /> : null}
  </Button>;
}
