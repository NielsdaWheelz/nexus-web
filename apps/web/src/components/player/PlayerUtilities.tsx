"use client";

import type { ReactNode, RefObject } from "react";
import * as Icon from "lucide-react";
import Button from "@/components/ui/Button";
import { usePlayerPresentation } from "@/lib/player/presentation";
import * as Player from "@/lib/player/playerRuntime";
import { cx } from "@/lib/ui/cx";
import styles from "./PlayerUtilities.module.css";

/**
 * One row in every state. The bar keeps each key in place and disables what has nothing to act
 * on; the sheet, shown only while loaded, omits what does not apply. The root owns the speed key.
 */
export default function PlayerUtilities(props: {
  readonly speed: ReactNode;
  readonly chaptersExpanded: boolean;
  readonly chaptersId: string;
  readonly chaptersRef: RefObject<HTMLButtonElement | null>;
  readonly onToggleChapters: () => void;
} & (
  | { readonly variant: "Bar"; readonly className: string; readonly upNext: ReactNode }
  | { readonly variant: "Sheet" }
)) {
  const { speed, chaptersExpanded, chaptersId, chaptersRef, onToggleChapters } = props;
  const { state, playbackSubject } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const presentation = usePlayerPresentation();
  const loaded = state.kind === "Loaded" ? state : null;
  const chapters = loaded !== null && loaded.source.descriptor.chapters.length > 0 && playbackSubject !== null;
  const bar = props.variant === "Bar";
  // With nothing loaded no panel exists, so the bar's key is plain: it discloses nothing.
  const chaptersKey = loaded === null
    ? <Button size="comfortable" iconOnly aria-label="chapters" icon={<Icon.ListMusic />} disabled />
    : <Button ref={chaptersRef} size="comfortable" iconOnly
      aria-label="chapters" aria-expanded={chaptersExpanded} aria-controls={chaptersId} aria-haspopup={bar ? "dialog" : undefined}
      disabled={!chapters} onClick={onToggleChapters} icon={<Icon.ListMusic />} />;
  return <div className={props.variant === "Bar" ? cx(styles.utilities, props.className) : cx(styles.utilities, styles.sheet)}>
    {props.variant === "Bar" ? props.upNext : null}
    {speed}
    {bar || chapters ? chaptersKey : null}
    <Button size="comfortable" iconOnly icon={<Icon.Square />} aria-label="stop playback" onClick={commands.stop} disabled={loaded === null} />
    {bar ? <Button size="comfortable" iconOnly icon={<Icon.X />} aria-label="hide player"
      tooltip={{ text: loaded?.phase === "Playing" || loaded?.phase === "Buffering" ? "hide player; playback continues" : "hide player" }}
      onClick={presentation.hide} /> : null}
  </div>;
}
