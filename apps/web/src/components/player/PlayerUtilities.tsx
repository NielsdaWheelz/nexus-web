"use client";

import type { ReactNode, RefObject } from "react";
import * as Icon from "lucide-react";
import Button from "@/components/ui/Button";
import { usePlayerPresentation } from "@/lib/player/presentation";
import * as Player from "@/lib/player/playerRuntime";
import { cx } from "@/lib/ui/cx";
import SpeedKey from "./SpeedKey";
import styles from "./PlayerUtilities.module.css";

type Picker = "Playback" | "Chapters";

/**
 * One row in every state. The bar keeps each key in place and disables what has nothing to act
 * on; the sheet, shown only while loaded, omits what does not apply.
 */
export default function PlayerUtilities(props: {
  readonly picker: Picker | null;
  readonly playbackId: string;
  readonly chaptersId: string;
  readonly rateRef: RefObject<HTMLButtonElement | null>;
  readonly chaptersRef: RefObject<HTMLButtonElement | null>;
  readonly settings: { readonly status: string | null; readonly failed: boolean; readonly busy: boolean };
  readonly onToggle: (picker: Picker) => void;
} & (
  | { readonly variant: "Bar"; readonly className: string; readonly upNext: ReactNode }
  | { readonly variant: "Sheet" }
)) {
  const { picker, playbackId, chaptersId, rateRef, chaptersRef, settings, onToggle } = props;
  const { state, playbackSubject } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const presentation = usePlayerPresentation();
  const loaded = state.kind === "Loaded" ? state : null;
  const chapters = loaded !== null && loaded.source.descriptor.chapters.length > 0 && playbackSubject !== null;
  const bar = props.variant === "Bar";
  return <div className={props.variant === "Bar" ? cx(styles.utilities, props.className) : cx(styles.utilities, styles.sheet)}>
    {props.variant === "Bar" ? props.upNext : null}
    <SpeedKey ref={rateRef} variant={props.variant} expanded={picker === "Playback"} controls={playbackId}
      status={settings.status} failed={settings.failed} busy={settings.busy} onToggle={() => onToggle("Playback")} />
    {bar || chapters ? <Button ref={chaptersRef} size="comfortable" iconOnly
      aria-label="chapters" aria-expanded={picker === "Chapters"} aria-controls={chaptersId} aria-haspopup={bar ? "dialog" : undefined}
      disabled={!chapters} onClick={() => onToggle("Chapters")} icon={<Icon.ListMusic />} /> : null}
    <Button size="comfortable" iconOnly icon={<Icon.Square />} aria-label="stop playback" onClick={commands.stop} disabled={loaded === null} />
    {bar ? <Button size="comfortable" iconOnly icon={<Icon.X />} aria-label="hide player"
      tooltip={{ text: loaded?.phase === "Playing" || loaded?.phase === "Buffering" ? "hide player; playback continues" : "hide player" }}
      onClick={presentation.hide} /> : null}
  </div>;
}
