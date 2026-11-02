"use client";

import type { ReactElement, Ref } from "react";
import Button from "@/components/ui/Button";
import type { BarKey, BarMode } from "@/lib/player/barModel";
import * as Player from "@/lib/player/playerRuntime";
import * as Icon from "@/lib/ui/icons";
import { cx } from "@/lib/ui/cx";
import styles from "./PlayerTransport.module.css";

/**
 * Previous, back 15, the disc, forward 30, next: five 44px slots, so the disc keeps its x through
 * every mode at 60rem and up. A key the mode lacks holds its slot unpainted; a key whose
 * precondition fails stays focusable and refuses. The mini shows the disc alone.
 */
export default function PlayerTransport({ variant, mode, keys, discRef, previousRef, nextRef }: {
  readonly variant: "Bar" | "Mini" | "Sheet";
  readonly mode: BarMode;
  readonly keys: ReadonlyMap<BarKey, "Enabled" | "Disabled">;
  readonly discRef?: Ref<HTMLButtonElement>;
  readonly previousRef?: Ref<HTMLButtonElement>;
  readonly nextRef?: Ref<HTMLButtonElement>;
}) {
  const commands = Player.usePlayerCommands();
  const { pendingPlayback, queue } = Player.usePlayerSession();
  const loaded = mode.kind === "Active" || mode.kind === "Advancing" ? mode.loaded : null;
  // pausing during a load retires it and leaves the source, so the disc resumes from there.
  const offerPause = pendingPlayback !== null || loaded?.phase === "Playing" || loaded?.phase === "Buffering";
  const queueBusy = queue.phase === "Preparing" || queue.phase === "Saving";
  const busy = loaded?.phase === "Buffering" ? "buffering" : pendingPlayback !== null && !queueBusy ? "starting" : null;
  // only a playing bar narrows; at rest every key fits.
  const tiered = mode.kind === "Active" || mode.kind === "Advancing";
  const key = (name: BarKey, label: string, icon: ReactElement, act: () => void,
    options: { ref?: Ref<HTMLButtonElement>; tooltip?: string; className?: string; busy?: string | null } = {}) => {
    const state = keys.get(name);
    return <Button ref={options.ref} size="comfortable" emphasis={name === "disc" ? "strong" : undefined} iconOnly icon={icon} aria-label={label} onClick={act}
      tooltip={options.tooltip === undefined ? undefined : { text: options.tooltip }}
      aria-disabled={state === "Disabled" || undefined} tabIndex={state === undefined ? -1 : undefined}
      aria-busy={options.busy ? true : undefined} aria-description={options.busy ?? undefined}
      data-player-play={name === "disc" || undefined}
      className={cx(styles.key, options.className, state === undefined && styles.absent)} />;
  };
  const disc = key("disc", offerPause ? "pause media player" : "play media player", <Icon.PlayPause playing={offerPause} />,
    offerPause ? commands.pause : commands.resume, { ref: discRef, tooltip: offerPause ? "pause" : "play", className: styles.disc, busy });
  if (variant === "Mini") return disc;
  return <div className={cx(styles.transport, variant === "Sheet" && styles.sheet, tiered && styles.tiered)} role="group" aria-label="media player controls">
    {key("previous", "previous", <Icon.Previous />, commands.previous, { ref: previousRef, className: styles.outer })}
    {key("back", "back 15 seconds", <Icon.SeekBack15 />, () => commands.skipBy(-Player.PLAYER_SKIP_BACK_MS), { tooltip: "back 15 · ←", className: styles.skip })}
    {disc}
    {key("forward", "forward 30 seconds", <Icon.SeekForward30 />, () => commands.skipBy(Player.PLAYER_SKIP_FORWARD_MS), { tooltip: "forward 30 · →", className: styles.skip })}
    {key("next", "next", <Icon.Next />, commands.next, { ref: nextRef, className: styles.outer })}
  </div>;
}
