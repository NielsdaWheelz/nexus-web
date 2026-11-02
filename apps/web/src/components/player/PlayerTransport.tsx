"use client";

import * as Icon from "lucide-react";
import Button from "@/components/ui/Button";
import * as Player from "@/lib/player/playerRuntime";
import { cx } from "@/lib/ui/cx";
import styles from "./PlayerTransport.module.css";

/**
 * queue admission and loaded-source controls have independent preconditions.
 * the bar offers every key; the mini, and a sheet with nothing loaded, offer only the disc.
 */
export default function PlayerTransport({ variant }: { readonly variant: "Bar" | "Mini" | "Sheet" }) {
  const commands = Player.usePlayerCommands();
  const { state, queue, pendingPlayback, playbackSubject } = Player.usePlayerSession();
  const loaded = state.kind === "Loaded" ? state : null;
  const queueBusy = queue.phase === "Preparing" || queue.phase === "Saving";
  const preparingPlayback = pendingPlayback !== null && !queueBusy;
  const offerPause = pendingPlayback !== null || loaded?.phase === "Playing" || loaded?.phase === "Buffering";
  const queueReady = queue.known && queue.phase === "Ready" && state.kind !== "Unavailable";
  const header = queue.header;
  const canPlay = offerPause || loaded !== null || (queueReady && header !== null && header.current_entry_id !== null);
  const canSkip = loaded !== null && playbackSubject !== null;
  const discOnly = variant === "Mini" || (variant === "Sheet" && loaded === null);
  return <div className={cx(styles.transport, variant === "Sheet" && styles.sheet)} role="group" aria-label="media player controls">
    {discOnly ? null : <Button size="comfortable" iconOnly icon={<Icon.SkipBack />} aria-label="previous" onClick={commands.previous}
      disabled={!queueReady || header === null || header.count === 0} />}
    {discOnly ? null : <Button size="comfortable" iconOnly aria-label="back 15 seconds" disabled={!canSkip}
      onClick={() => commands.skipBy(-Player.PLAYER_SKIP_BACK_MS)}
      icon={<span className={styles.numberedSkip}><Icon.RotateCcw /><span>15</span></span>} />}
    <Button emphasis="strong" size="comfortable" iconOnly className={styles.playPause}
      onClick={offerPause ? commands.pause : commands.resume} disabled={!canPlay}
      data-player-play="true" aria-busy={loaded?.phase === "Buffering" || preparingPlayback || undefined}
      aria-description={preparingPlayback ? "preparing playback…" : loaded?.phase === "Buffering" ? "buffering" : undefined}
      aria-label={offerPause ? "pause media player" : "play media player"}
      icon={offerPause ? <Icon.Pause fill="currentColor" /> : <Icon.Play fill="currentColor" />} />
    {discOnly ? null : <Button size="comfortable" iconOnly aria-label="forward 30 seconds" disabled={!canSkip}
      onClick={() => commands.skipBy(Player.PLAYER_SKIP_FORWARD_MS)}
      icon={<span className={styles.numberedSkip}><Icon.RotateCw /><span>30</span></span>} />}
    {discOnly ? null : <Button size="comfortable" iconOnly icon={<Icon.SkipForward />} aria-label="next" onClick={commands.next}
      disabled={!queueReady || header === null || header.current_index === null || header.current_index + 1 >= header.count} />}
  </div>;
}
