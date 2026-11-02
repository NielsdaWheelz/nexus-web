"use client";

import type { ReactNode, RefObject } from "react";
import Button from "@/components/ui/Button";
import type { BarKey } from "@/lib/player/barModel";
import * as Player from "@/lib/player/playerRuntime";
import * as Icon from "@/lib/ui/icons";
import { cx } from "@/lib/ui/cx";
import styles from "./PlayerUtilities.module.css";

/**
 * Speed, chapters, up next and more on the bar, each 44px and holding its slot when the mode
 * lacks it. Narrow, a playing bar sheds chapters, then up next, to more. The sheet shows speed,
 * chapters and a labelled stop. The root owns speed, up next and more; this row owns chapters.
 */
export default function PlayerUtilities(props: {
  readonly keys: ReadonlyMap<BarKey, "Enabled" | "Disabled">;
  readonly speed: ReactNode;
  readonly chaptersExpanded: boolean;
  readonly chaptersId: string;
  readonly chaptersRef: RefObject<HTMLButtonElement | null>;
  readonly onToggleChapters: () => void;
} & (
  | { readonly variant: "Bar"; readonly tiered: boolean; readonly upNext: ReactNode; readonly more: ReactNode }
  | { readonly variant: "Sheet" }
)) {
  const { keys, speed, chaptersExpanded, chaptersId, chaptersRef, onToggleChapters } = props;
  const commands = Player.usePlayerCommands();
  const bar = props.variant === "Bar";
  const chapters = <Button ref={chaptersRef} size="comfortable" iconOnly icon={<Icon.Chapters />}
    aria-label="chapters" aria-expanded={chaptersExpanded} aria-controls={chaptersId} aria-haspopup={bar ? "dialog" : undefined}
    aria-disabled={keys.get("chapters") === "Disabled" || undefined} onClick={onToggleChapters} className={styles.key} />;
  if (props.variant === "Sheet") return <div className={cx(styles.utilities, styles.sheet)}>
    {speed}
    {keys.has("chapters") ? chapters : null}
    <Button size="comfortable" icon={<Icon.Stop />} aria-label="stop playback" onClick={commands.stop}>stop</Button>
  </div>;
  // an absent key holds its slot unseen; a tier-hidden one leaves for more.
  const slot = (key: BarKey, node: ReactNode, tier: string | null = null) =>
    <span className={cx(styles.slot, !keys.has(key) && styles.absent, props.tiered && tier)}>{node}</span>;
  return <div className={styles.utilities}>
    {slot("speed", speed)}
    {slot("chapters", chapters, styles.belowFold)}
    {slot("upNext", props.upNext, styles.belowNarrow)}
    {slot("more", props.more)}
  </div>;
}
