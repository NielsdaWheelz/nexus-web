"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import Tooltip from "@/components/ui/Tooltip";
import type { Schema } from "@/lib/api/wire";
import { formatClock } from "@/lib/formatClock";
import { folioRest, positionAt, type BarClock } from "@/lib/player/barModel";
import * as Player from "@/lib/player/playerRuntime";
import type { PlayerOrigin } from "./usePlayerOrigin";
import styles from "./PlayerRule.module.css";

type Chapter = Schema<"ChapterOut">;
interface Point { readonly x: number; readonly positionMs: number; readonly snapped: boolean }

const NO_CHAPTERS: readonly Chapter[] = [];
const time = (ms: number) => formatClock(ms / 1000);
const chapterAt = (chapters: readonly Chapter[], ms: number) => chapters.findLast(chapter => chapter.start_ms <= ms) ?? null;

/**
 * The timeline as the top edge of the bar: unplayed hairline, played accent hanging from the same
 * edge, chapter cuts, and the cold pose while nothing sounds. Bar and sheet own the pointer through
 * `positionAt`: a press moves the fill and the folio's draft at once and seeks nothing; release seeks
 * once and holds the draft until the clock arrives; esc cancels. The native range keeps the value,
 * the keys and the name. The mini's rule is a decorative edge.
 */
export default function PlayerRule(props: { readonly clock: BarClock; readonly origin: PlayerOrigin } & (
  | { readonly variant: "Mini" }
  | { readonly variant: "Bar" | "Sheet"; readonly draft: number | null; readonly onDraft: (draft: number | null) => void }
)) {
  return props.variant === "Mini" ? <Edge clock={props.clock} origin={props.origin} />
    : <Rail variant={props.variant} clock={props.clock} origin={props.origin} draft={props.draft} onDraft={props.onDraft} />;
}

/** The clock of a live load, with android's descriptor duration until media3 knows its own. */
function useLiveClock(clock: BarClock, origin: PlayerOrigin) {
  const { positionMs, durationMs } = Player.usePlayerTimeline();
  const { retire } = origin;
  useEffect(() => { retire(positionMs); }, [retire, positionMs]);
  const live = clock.kind === "Live" ? clock.loaded : null;
  const durationMsKnown = live === null ? 0 : durationMs > 0 ? durationMs : live.source.descriptor.duration_ms ?? 0;
  const cold = live === null || live.phase === "Paused" || live.phase === "Ended" || live.playbackFailed || live.error !== null;
  return { live, positionMs, durationMs: durationMsKnown, cold };
}

const fill = (fraction: number) => ({ "--played": Math.min(1, Math.max(0, fraction)) }) as CSSProperties;

function Edge({ clock, origin }: { readonly clock: BarClock; readonly origin: PlayerOrigin }) {
  const { live, positionMs, durationMs, cold } = useLiveClock(clock, origin);
  const fraction = live !== null ? durationMs > 0 ? positionMs / durationMs : 0 : clock.kind === "Still" ? clock.progress : null;
  return <span className={styles.edge} data-cold={cold} aria-hidden="true">
    <span className={styles.line} />
    {fraction !== null ? <span className={styles.played} style={fill(fraction)} /> : null}
  </span>;
}

function Rail({ variant, clock, origin, draft, onDraft }: {
  readonly variant: "Bar" | "Sheet";
  readonly clock: BarClock;
  readonly origin: PlayerOrigin;
  readonly draft: number | null;
  readonly onDraft: (draft: number | null) => void;
}) {
  const { live, positionMs, durationMs, cold } = useLiveClock(clock, origin);
  const { playbackSubject } = Player.usePlayerSession();
  const seekable = clock.kind === "Live" && clock.seekable && playbackSubject !== null && durationMs > 0;
  const chapters = live?.source.descriptor.chapters ?? NO_CHAPTERS;
  const rail = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const [point, setPoint] = useState<Point | null>(null);
  const [bubble, setBubble] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [hold, setHold] = useState<{ readonly targetMs: number } | null>(null);
  const scrub = useRef<{ readonly pointerId: number; readonly subject: string } | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleLeft = useRef(-Infinity);

  useLayoutEffect(() => {
    const element = rail.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { if (dwell.current !== null) clearTimeout(dwell.current); }, []);

  // A cut is a 2px gap at a chapter start, drawn only if it clears the last drawn one by 6px; only
  // drawn starts are detents.
  const cuts = useMemo(() => {
    const drawn: number[] = [];
    let lastX = 0;
    for (const chapter of chapters.slice(1)) {
      if (durationMs <= 0 || chapter.start_ms >= durationMs) break;
      const x = (chapter.start_ms / durationMs) * width;
      if (x - lastX > 6) { drawn.push(chapter.start_ms); lastX = x; }
    }
    return drawn;
  }, [chapters, durationMs, width]);

  const shown = Math.min(draft ?? positionMs, durationMs || Infinity);
  const percent = (ms: number) => `${durationMs > 0 ? (Math.min(ms, durationMs) / durationMs) * 100 : 0}%`;

  const settle = () => { setHold(null); onDraft(null); };
  // released: the draft stands until the clock is within 1.5s of it, or 1.5s pass.
  useEffect(() => {
    if (hold === null) return;
    const timer = setTimeout(settle, 1500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one deadline per release
  }, [hold]);
  useEffect(() => {
    if (hold !== null && Math.abs(positionMs - hold.targetMs) <= 1500) settle();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the clock settles the release it names
  }, [hold, positionMs]);

  const cancel = () => {
    const captured = scrub.current;
    scrub.current = null;
    setScrubbing(false);
    setBubble(false);
    setPoint(null);
    if (captured !== null && rail.current?.hasPointerCapture(captured.pointerId)) rail.current.releasePointerCapture(captured.pointerId);
    onDraft(null);
  };
  // a scrub belongs to one load; esc during it belongs to the rail.
  useEffect(() => {
    if (!scrubbing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- cancel reads refs and stable setters
  }, [scrubbing]);
  useEffect(() => {
    if (scrub.current !== null && scrub.current.subject !== playbackSubject) cancel();
    setHold(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new subject retires the old load's scrub
  }, [playbackSubject]);

  useLayoutEffect(() => {
    const element = bubbleRef.current;
    if (element === null || point === null) return;
    const bubbleWidth = element.offsetWidth;
    element.style.left = `${Math.max(8, Math.min(width - bubbleWidth - 8, point.x - bubbleWidth / 2))}px`;
  });

  const pointAt = (event: PointerEvent<HTMLDivElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = positionAt(event.clientX - box.left, box.width, durationMs, cuts, event.pointerType === "mouse" ? 3 : 6);
    return { ...at, x: (at.positionMs / durationMs) * box.width };
  };
  const leave = () => {
    if (dwell.current !== null) clearTimeout(dwell.current);
    dwell.current = null;
    if (bubble) bubbleLeft.current = performance.now();
    setBubble(false);
    setPoint(null);
  };
  const onMark = (event: PointerEvent<HTMLDivElement>) => event.target instanceof Element && event.target.closest("button") !== null;

  const mark = origin.origin === null ? null : { label: `return to ${time(origin.origin.atMs)}`, left: percent(origin.origin.atMs) };
  const pointed = point === null ? null : chapterAt(chapters, point.positionMs);
  const valuetext = `${time(shown)} of ${time(durationMs)}`;
  const current = chapterAt(chapters, shown);
  const played = live !== null ? durationMs > 0 ? shown / durationMs : 0 : clock.kind === "Still" ? clock.progress : null;
  const band = <div ref={rail} className={variant === "Bar" ? styles.rail : styles.band}
    data-cold={cold} data-inert={!seekable} data-approach={point !== null && !scrubbing} data-scrub={scrubbing}
    onPointerMove={event => {
      if (!seekable) return;
      if (scrub.current?.pointerId === event.pointerId) {
        const next = pointAt(event);
        setPoint(next);
        onDraft(next.positionMs);
        return;
      }
      if (onMark(event)) { leave(); return; }
      setPoint(pointAt(event));
      if (!bubble && dwell.current === null) dwell.current = setTimeout(() => { dwell.current = null; setBubble(true); },
        performance.now() - bubbleLeft.current < 1500 ? 0 : 100);
    }}
    onPointerLeave={() => { if (scrub.current === null) leave(); }}
    onPointerDown={event => {
      if (!seekable || playbackSubject === null || !event.isPrimary || event.button !== 0 || onMark(event)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      scrub.current = { pointerId: event.pointerId, subject: playbackSubject };
      const next = pointAt(event);
      setScrubbing(true);
      setPoint(next);
      setBubble(true);
      onDraft(next.positionMs);
    }}
    onPointerUp={event => {
      const captured = scrub.current;
      if (captured?.pointerId !== event.pointerId) return;
      const release = pointAt(event);
      scrub.current = null;
      setScrubbing(false);
      setBubble(false);
      setPoint(null);
      if (captured.subject !== playbackSubject) { onDraft(null); return; }
      onDraft(release.positionMs);
      setHold({ targetMs: release.positionMs });
      origin.seek(release.positionMs);
    }}
    onPointerCancel={event => { if (scrub.current?.pointerId === event.pointerId) cancel(); }}
    onLostPointerCapture={event => { if (scrub.current?.pointerId === event.pointerId) cancel(); }}>
    <span className={styles.line} />
    {played !== null ? <span className={styles.played} style={fill(played)} /> : null}
    {cuts.map(start => <span key={start} className={styles.cut} style={{ left: percent(start) }} />)}
    {variant === "Bar" ? <>
      <span className={styles.tick} style={{ left: percent(positionMs) }} />
      <span className={styles.stem} style={{ left: point?.x ?? 0 }} />
      <span ref={bubbleRef} className={styles.bubble} data-shown={bubble && point !== null} aria-hidden="true">
        <span className={styles.bubbleTime}>{point === null ? null : time(point.positionMs)}</span>
        {pointed !== null ? <span className={styles.bubbleChapter} data-snapped={point?.snapped}>{pointed.title}</span> : null}
      </span>
    </> : null}
    {seekable ? <input type="range" className={styles.input} min={0} max={durationMs} step={1000} value={shown}
      aria-label="seek playback position" aria-valuetext={current === null ? valuetext : `${valuetext}, ${current.title}`}
      onKeyDown={event => {
        const target = keyTarget(event.key, shown, durationMs, chapters);
        if (target === undefined) return;
        event.preventDefault();
        if (target !== null) origin.seek(Math.min(durationMs, Math.max(0, target)));
      }}
      onChange={event => origin.seek(Number(event.currentTarget.value))} /> : null}
    {seekable && mark !== null ? <Tooltip text={mark.label} renderTrigger={help =>
      <button {...help} type="button" className={styles.mark} style={{ left: mark.left }} aria-label={mark.label} onClick={origin.returnToOrigin} />} /> : null}
  </div>;
  if (variant === "Bar") return band;
  const readout = scrubbing ? [time(shown), current?.title].filter(Boolean).join(" · ") : current?.title ?? null;
  return <div className={styles.sheet}>
    <p className={styles.readout} aria-hidden="true">{readout}</p>
    {band}
    <p className={styles.times} aria-hidden="true">
      <span>{time(shown)}</span>
      <span>{live !== null && durationMs > 0 ? folioRest(durationMs - shown, live.rate, live.shortenPauses) : null}</span>
    </p>
  </div>;
}

/** The focused rail's keys: undefined leaves the key alone, null takes it with nothing to do. */
function keyTarget(key: string, shown: number, durationMs: number, chapters: readonly Chapter[]): number | null | undefined {
  switch (key) {
    case "ArrowLeft": return shown - 15_000;
    case "ArrowRight": return shown + 30_000;
    case "ArrowUp": return shown + 1_000;
    case "ArrowDown": return shown - 1_000;
    case "Home": return 0;
    case "End": return durationMs;
    case "PageUp":
      return chapters.length === 0 ? shown + 300_000 : chapters.find(chapter => chapter.start_ms > shown + 500)?.start_ms ?? null;
    // back within 3s of a start goes one further.
    case "PageDown":
      return chapters.length === 0 ? shown - 300_000 : chapters.findLast(chapter => chapter.start_ms < shown - 3_000)?.start_ms ?? 0;
    default: return undefined;
  }
}
