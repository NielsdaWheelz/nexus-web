// The glyph lexicon: one drawing, one gloss. The object comes from the label or the
// place, so one sign covers many objects without saying two things.
//
// Consumers write `import * as Icon from "@/lib/ui/icons"` and name a sign. Never a
// computed `Icon[name]`, never a dynamic lucide import, never lucide itself: a consumer
// depends on the name, not the drawing, so a drawing changes here in one line. Every
// export is decorative, paints currentColor, and takes `className` and `size`. A new
// export is paid for by a bare use: a sign read alone on a control, as a type or as a
// place. A menu row never earns one; with no sign it keeps its blank slot. Size belongs
// to the slot (`--control-icon-size`, `.menuItemIcon`); waiting belongs to `control.tsx`.
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Ellipsis,
  EyeOff,
  Headphones,
  LayoutList,
  ListOrdered,
  Pause as PauseDrawing,
  Play as PlayDrawing,
  SkipBack,
  SkipForward,
  Square,
  createLucideIcon,
} from "lucide-react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { Icon as LucideGlyph, type IconNode } from "lucide-react";
import type { CSSProperties } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./icons.module.css";

export type Glyph = LucideIcon;

// The name is the gloss. The comment is the promise.

// Signs that promise a consequence.
export const Stop: Glyph = Square;                    // halt what is running; what is done stays

// Verbs.
export const Hide: Glyph = EyeOff;                    // conceal it; it stays
export const MoveUp: Glyph = ArrowUp;                 // move the thing up
export const MoveDown: Glyph = ArrowDown;             // move the thing down
export const More: Glyph = Ellipsis;                  // more commands

// Transport.
export const Play: Glyph = PlayDrawing;               // sound on
export const Pause: Glyph = PauseDrawing;             // sound held
export const Previous: Glyph = SkipBack;              // previous entry
export const Next: Glyph = SkipForward;               // next entry

// Direction.
export const Choose: Glyph = ChevronsUpDown;          // opens a choice

// Places.
export const UpNext: Glyph = LayoutList;              // what plays next
export const Chapters: Glyph = ListOrdered;           // the parts of this episode
export const Player: Glyph = Headphones;              // the player

// Drawn glyphs carry a nexus- name, so their class never matches a stock glyph.
// The lectern: a closed desk with converging sides, a ledge, a post and splayed legs.
// Its axis sits 0.75 off centre so every edge lands on a pixel at 1x.
export const Lectern: Glyph = /*#__PURE__*/ createLucideIcon("nexus-lectern", [ // what you are working through
  ["path", { d: "M5.25 3.75h12l2 9h-16z", key: "desk" }],
  ["path", { d: "M4.25 8.25h14", key: "ledge" }],
  ["path", { d: "M11.25 12.75v6", key: "post" }],
  ["path", { d: "M7.5 21 11.25 18.75 15 21", key: "legs" }],
]);
// The skips: lucide's rotate arcs around numerals drawn as rounded rectilinear outlines,
// 7.75 tall, clear of the arrowhead by a stroke at 20px. The only anticlockwise arc left.
export const SeekBack15: Glyph = /*#__PURE__*/ createLucideIcon("nexus-seek-back-15", [ // fifteen seconds back
  ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "arc" }],
  ["path", { d: "M3 3v5h5", key: "head" }],
  ["path", { d: "M8 10.75 9 9.75v7.75", key: "one" }],
  ["path", { d: "M15.5 9.75h-4V13h3a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-3", key: "five" }],
]);
export const SeekForward30: Glyph = /*#__PURE__*/ createLucideIcon("nexus-seek-forward-30", [ // thirty seconds on
  ["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", key: "arc" }],
  ["path", { d: "M21 3v5h-5", key: "head" }],
  ["path", { d: "M7.5 9.75h3a.75.75 0 0 1 .75.75v6.25a.75.75 0 0 1-.75.75h-3M8.75 13.625h2.5", key: "three" }],
  ["rect", { x: "12.75", y: "9.75", width: "3.75", height: "7.75", rx: "1.875", key: "zero" }],
]);

// Playback's own glyphs: parametric, so lucide's Icon draws the node list a prop selects.
// Their module keeps the disc's and the dial's strokes scaling and animates them. The dial is
// the one export that paints more than currentColor: away from 1× its needle and hub take
// `--ink` and its sweep `--accent`.
type PlaybackGlyphProps = Pick<LucideProps, "className" | "size">;

const PAUSE_POSE: IconNode = [
  ["path", { d: "M7 5.75L9.5 5.75L9.5 18.25L7 18.25Z", fill: "currentColor", key: "a" }],
  ["path", { d: "M14.5 5.75L17 5.75L17 18.25L14.5 18.25Z", fill: "currentColor", key: "b" }],
];
const PLAY_POSE: IconNode = [
  ["path", { d: "M8 5.5L14 8.75L14 15.25L8 18.5Z", fill: "currentColor", key: "a" }],
  ["path", { d: "M14 8.75L20 12L20 12L14 15.25Z", fill: "currentColor", key: "b" }],
];

/** `playing` draws pause, the act a press takes. Both poses are two four-point paths, so css `d`
 * interpolates between them. */
export function PlayPause({ playing, className, size }: PlaybackGlyphProps & { readonly playing: boolean }) {
  return <LucideGlyph iconNode={playing ? PAUSE_POSE : PLAY_POSE} size={size} className={cx(styles.playPause, className)} />;
}

/** About the pivot (12, 12.5): the rim, r 9 and open ±145° at the foot; the sweep on the rim's
 * circle; ticks at twelve, nine and three; the needle; the hub. */
const SPEED_DIAL: IconNode = [
  ["path", { d: "M6.84 19.87A9 9 0 1 1 17.16 19.87", key: "rim" }],
  ["circle", { cx: "12", cy: "12.5", r: "9", pathLength: "360", strokeLinecap: "butt", className: styles.sweep, key: "sweep" }],
  ["path", { d: "M12 3.5v2M3 12.5h2M19 12.5h2", key: "ticks" }],
  ["path", { d: "M12 12.5V6", className: styles.needle, key: "needle" }],
  ["circle", { cx: "12", cy: "12.5", r: "1.25", fill: "currentColor", stroke: "none", className: styles.hub, key: "hub" }],
];

/** θ = 90·log2(rate): ½× at nine, 1× at twelve, 2× at three. The caller passes the rate its control
 * prints, so needle and figure agree; playbackRate.ts owns rounding. The glyph sets θ alone, and
 * its module turns the needle and lays the sweep from it on every frame of a glide. */
export function Speed({ rate, className, size }: PlaybackGlyphProps & { readonly rate: number }) {
  return <LucideGlyph iconNode={SPEED_DIAL} size={size} className={cx(styles.speed, rate !== 1 && styles.altered, className)}
    style={{ "--dial-angle": (90 * Math.log2(rate)).toFixed(2) } as CSSProperties} />;
}

const EFFORT_RIM: IconNode[number] = ["path", { d: "M4 15.5a8 8 0 0 1 16 0", key: "rim" }];
const EFFORT_HUB: IconNode[number] = ["circle", { cx: "12", cy: "15.5", r: "1.5", fill: "currentColor", stroke: "none", key: "hub" }];

/** The effort picker's own dial on the 24 grid: a half rim from nine to three over the pivot
 * (12, 15.5). The needle spans nine to three across the choices; null draws none. */
export function Effort({ position, className, size }: PlaybackGlyphProps & { readonly position: number | null }) {
  const needle: IconNode = position === null ? [] : [["path", {
    d: "M12 15.5V8.5", transform: `rotate(${(-90 + 180 * position).toFixed(2)} 12 15.5)`, className: styles.needle, key: "needle",
  }]];
  return <LucideGlyph iconNode={[EFFORT_RIM, ...needle, EFFORT_HUB]} size={size} className={cx(styles.effort, className)} />;
}
