"use client";

import { useEffect, useState, type ReactNode, type Ref } from "react";
import Artwork, { remoteArtwork } from "@/components/ui/Artwork";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import type { Schema } from "@/lib/api/wire";
import { assertNever } from "@/lib/assertNever";
import { barClock, type BarMode } from "@/lib/player/barModel";
import * as Player from "@/lib/player/playerRuntime";
import { cx } from "@/lib/ui/cx";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import PlayerFolio from "./PlayerFolio";
import { unavailableMessages } from "./PlayerFailures";
import styles from "./PlayerIdentity.module.css";

/** An episode as the identity shows it: its show's art, its title, the show that names it. */
interface Subject { readonly mediaId: string; readonly title: string; readonly show: string | null; readonly imageUrl: string | null }

/** What one mode paints. `subject` takes line 1; `line1` is a state word for a mode with none. */
interface View {
  readonly subject: Subject | null;
  readonly line1: string | null;
  readonly line2: ReactNode;
  readonly description: string | null;
  readonly linked: boolean;
  readonly opensSheet: boolean;
  readonly muted: boolean;
  readonly failed: boolean;
}

const QUIET: View = { subject: null, line1: null, line2: null, description: null, linked: false, opensSheet: false, muted: false, failed: false };

/**
 * The episode before the state: line 1 is the title whenever an episode is known, and a state word
 * takes it only when there is none. A pending subject paints a frame and no text. The bar and sheet
 * link to a known episode; the mini opens the sheet in the modes that have one. Session only: the
 * fold's minutes are the folio's own leaf.
 */
export default function PlayerIdentity(props: {
  readonly mode: BarMode;
  readonly openLectern: (event: TargetActivationEvent) => void;
} & (
  | { readonly variant: "Bar" | "Sheet"; readonly open: (event: TargetActivationEvent, subject: Subject) => void }
  | { readonly variant: "Mini"; readonly buttonRef: Ref<HTMLButtonElement>; readonly onOpenSheet: () => void }
)) {
  const { mode, variant } = props;
  const chapter = Player.useCurrentChapter();
  const late = useLate(mode.kind === "Unknown");
  const view = identityView(mode, variant, chapter, late, props.openLectern);
  const size = variant === "Sheet" ? 64 : 44;
  const { subject } = view;
  const contents = <span className={styles.row}>
    <span className={styles.art}>
      {subject === null ? <span className={styles.frame} style={{ width: size, height: size }} aria-hidden="true" />
        : <Artwork title={subject.show ?? subject.title} source={remoteArtwork(subject.imageUrl)} size={size} />}
      {view.failed ? <span className={styles.dot} aria-hidden="true" /> : null}
    </span>
    <span className={styles.copy}>
      {subject !== null ? <span className={styles.title}>{subject.title}</span>
        : view.line1 !== null ? <span className={cx(styles.title, styles.plain)}>{view.line1}</span> : null}
      {view.line2 !== null ? <span className={styles.line2}>{view.line2}</span> : null}
    </span>
  </span>;
  const className = cx(styles.identity, variant === "Sheet" && styles.sheet, view.muted && styles.muted);
  const show = subject === null || subject.show === null ? "" : `, ${subject.show}`;
  const description = view.description ?? undefined;
  if (props.variant === "Mini") {
    if (!view.opensSheet) return <div className={className}>{contents}</div>;
    const name = subject?.title ?? view.line1;
    return <Button ref={props.buttonRef} className={cx(className, styles.opener)} onClick={props.onOpenSheet}
      aria-label={`open now playing${name === null ? "" : `: ${name}`}${show}`} aria-description={description}>{contents}</Button>;
  }
  if (subject === null || !view.linked) return <div className={className}>{contents}</div>;
  const open = props.open;
  return <ButtonLink href={`/media/${subject.mediaId}`} className={cx(className, styles.opener)} data-workspace-rich-target="true"
    onClick={event => open(event, subject)} onKeyDown={event => open(event, subject)}
    aria-label={`open ${subject.title}${show}`} aria-description={description}>{contents}</ButtonLink>;
}

function identityView(mode: BarMode, variant: "Bar" | "Sheet" | "Mini", chapter: Schema<"ChapterOut"> | null, late: boolean,
  openLectern: (event: TargetActivationEvent) => void): View {
  // A load's identity. The sheet's readout carries the chapter, so its line 2 names the show; the
  // fold's minutes lead line 2 in the mini always and in the bar under 46rem.
  const playing = (loaded: Extract<BarMode, { kind: "Active" }>["loaded"]): Pick<View, "subject" | "line2"> => {
    const { descriptor } = loaded.source;
    return {
      subject: { mediaId: descriptor.media_id, title: descriptor.title, show: descriptor.subtitle, imageUrl: descriptor.artwork_url },
      line2: variant === "Sheet" ? descriptor.subtitle : <>
        <span className={variant === "Bar" ? styles.fold : undefined}><PlayerFolio variant="Inline" clock={barClock(mode)} /></span>
        {chapter?.title ?? descriptor.subtitle}
      </>,
    };
  };
  switch (mode.kind) {
    case "Unknown":
      return { ...QUIET, line1: mode.read === "Failed" ? "couldn’t load queue" : mode.read === "Loading" && late ? "loading queue…" : null };
    case "Empty":
      return { ...QUIET, line1: "nothing queued",
        // eslint-disable-next-line @next/next/no-html-link-for-pages -- the workspace's own gesture opens it
        line2: <a href="/lectern" className={styles.link} data-workspace-rich-target="true" onClick={openLectern} onKeyDown={openLectern}>open lectern</a> };
    case "Finished": return { ...QUIET, line1: "queue finished", line2: mode.count === 1 ? "1 episode" : `${mode.count} episodes` };
    case "UpdateRequired":
      return { ...QUIET, line1: unavailableMessages.UpdateRequired,
        // eslint-disable-next-line @next/next/no-html-link-for-pages -- the download page is the browser's
        line2: <a href="/android" className={styles.link}>update</a> };
    case "Stopped": {
      if (mode.episode.kind !== "Named") return { ...QUIET, opensSheet: true, line1: mode.episode.kind === "Unnamed" ? "playback stopped" : null };
      const place = mode.index === null ? null : `${mode.index + 1} of ${mode.count}`;
      return { ...QUIET, subject: mode.episode, linked: true, opensSheet: true,
        line2: place === null ? "stopped" : <>stopped <span aria-hidden="true">·</span> {place}</>,
        description: place === null ? "stopped" : `stopped, ${place}` };
    }
    case "Starting":
      if (mode.episode.kind !== "Named") return { ...QUIET, opensSheet: true, line1: mode.episode.kind === "Unnamed" ? "starting" : null };
      return { ...QUIET, subject: mode.episode, linked: true, opensSheet: true, line2: "starting", description: "starting" };
    case "NotResponding":
      if (mode.episode.kind !== "Named") return { ...QUIET, line1: mode.episode.kind === "Unnamed" ? unavailableMessages.NotResponding : null };
      return { ...QUIET, subject: mode.episode, linked: true, muted: true,
        line2: unavailableMessages.NotResponding, description: unavailableMessages.NotResponding };
    case "Advancing": return { ...QUIET, ...playing(mode.loaded), opensSheet: true, muted: true };
    case "Active":
      return { ...QUIET, ...playing(mode.loaded), linked: true, opensSheet: true, failed: mode.failed,
        description: mode.failed ? "playback needs attention" : null };
    default: return assertNever(mode);
  }
}

/** `Unknown` names its read only after 400ms, so a quick read never flashes. */
function useLate(waiting: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setLate(true), 400);
    return () => { clearTimeout(timer); setLate(false); };
  }, [waiting]);
  return late;
}
