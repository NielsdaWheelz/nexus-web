/** meaning to drawing, total and reviewable in this file. a name states meaning; one drawing may
 * carry several names, and each share is a claim. the slot owns size, and a standalone glyph,
 * parametric or not, takes `size`; --icon-stroke owns weight. */
import type { CSSProperties } from "react";
import {
  createLucideIcon,
  Ellipsis,
  Headphones,
  Icon as LucideGlyph,
  ListMusic,
  ListOrdered,
  ListVideo,
  Pause as LucidePause,
  Play as LucidePlay,
  Square,
  type IconNode,
  type LucideIcon,
} from "lucide-react";
import { cx } from "@/lib/ui/cx";
import styles from "./icons.module.css";

export type Glyph = LucideIcon;

export const Chapters = ListOrdered;
export const UpNext = ListVideo;
export const Lectern = ListMusic;
export const Stop = Square;
export const More = Ellipsis;
export const Player = Headphones;
export const Play = LucidePlay;
export const Pause = LucidePause;

/** lucide's skip-back and skip-forward, the triangle filled to stand with the disc between them. */
export const Previous = /*#__PURE__*/ createLucideIcon("previous", [
  ["path", { d: "M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z", fill: "currentColor", key: "triangle" }],
  ["path", { d: "M3 20V4", key: "bar" }],
]);
export const Next = /*#__PURE__*/ createLucideIcon("next", [
  ["path", { d: "M21 4v16", key: "bar" }],
  ["path", { d: "M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z", fill: "currentColor", key: "triangle" }],
]);

/** the figures restate PLAYER_SKIP_BACK_MS; change both together. */
export const SeekBack15 = /*#__PURE__*/ createLucideIcon("seek-back15", [
  ["path", { d: "M12 4.5a8.5 8.5 0 1 1-8.5 8.5", key: "arc" }],
  ["path", { d: "M14.6 2 11.6 4.5l3 2.5", key: "arrow" }],
  ["path", { d: "M7.75 11.25 10.25 9.5v7", key: "one" }],
  ["path", { d: "M16.25 9.5h-3.5v2.75h1.4a2.1 2.1 0 1 1-1.35 3.71", key: "five" }],
]);

/** the figures restate PLAYER_SKIP_FORWARD_MS; change both together. */
export const SeekForward30 = /*#__PURE__*/ createLucideIcon("seek-forward30", [
  ["path", { d: "M12 4.5a8.5 8.5 0 1 0 8.5 8.5", key: "arc" }],
  ["path", { d: "M9.4 2l3 2.5-3 2.5", key: "arrow" }],
  ["path", { d: "M7.7 9.95c1.5-.9 3.05 0 3.05 1.3a1.75 1.75 0 0 1-1.75 1.75", key: "three-upper" }],
  ["path", { d: "M7.25 16.05c1.75 1.3 3.5.25 3.5-1.3a1.75 1.75 0 0 0-1.75-1.75", key: "three-lower" }],
  ["rect", { x: "13.25", y: "9.5", width: "3.5", height: "7", rx: "1.75", key: "zero" }],
]);

const PAUSE_POSE: IconNode = [
  ["path", { d: "M7 5.75L9.5 5.75L9.5 18.25L7 18.25Z", fill: "currentColor", strokeWidth: "1.5", key: "a" }],
  ["path", { d: "M14.5 5.75L17 5.75L17 18.25L14.5 18.25Z", fill: "currentColor", strokeWidth: "1.5", key: "b" }],
];
const PLAY_POSE: IconNode = [
  ["path", { d: "M8 5.5L14 8.75L14 15.25L8 18.5Z", fill: "currentColor", strokeWidth: "1.5", key: "a" }],
  ["path", { d: "M14 8.75L20 12L20 12L14 15.25Z", fill: "currentColor", strokeWidth: "1.5", key: "b" }],
];

/** `playing` draws pause, the act a press takes. both poses are two four-point paths, so css `d`
 * interpolates between them; the stroke rounds corners and scales with the shape. */
export function PlayPause({ playing, size }: { playing: boolean; size?: number }) {
  return <LucideGlyph iconNode={playing ? PAUSE_POSE : PLAY_POSE} size={size} className={styles.playPause} />;
}

/** about the pivot (12, 12.5): the rim, r 9 and open ±145° at the foot; the sweep on the rim's
 * circle; ticks at twelve, nine and three; the needle; the hub. */
const SPEED_DIAL: IconNode = [
  ["path", { d: "M6.84 19.87A9 9 0 1 1 17.16 19.87", key: "rim" }],
  ["circle", { cx: "12", cy: "12.5", r: "9", pathLength: "360", strokeLinecap: "butt", className: styles.sweep, key: "sweep" }],
  ["path", { d: "M12 3.5v2M3 12.5h2M19 12.5h2", key: "ticks" }],
  ["path", { d: "M12 12.5V6", className: styles.needle, key: "needle" }],
  ["circle", { cx: "12", cy: "12.5", r: "1.25", fill: "currentColor", stroke: "none", className: styles.hub, key: "hub" }],
];

/** θ = 90·log2(rate): ½× at nine, 1× at twelve, 2× at three. the caller passes the rate its control
 * prints, so needle and figure agree; playbackRate.ts owns rounding. the glyph sets θ alone, and
 * its module turns the needle and lays the sweep from it on every frame of a glide. the sweep is a
 * dash on a 360-unit circle, so the dial scales its stroke. */
export function Speed({ rate, size }: { rate: number; size?: number }) {
  return <LucideGlyph iconNode={SPEED_DIAL} size={size} className={cx(styles.speed, rate !== 1 && styles.altered)}
    style={{ "--dial-angle": (90 * Math.log2(rate)).toFixed(2) } as CSSProperties} />;
}

const EFFORT_RIM: IconNode[number] = ["path", { d: "M4 15.5a8 8 0 0 1 16 0", key: "rim" }];
const EFFORT_HUB: IconNode[number] = ["circle", { cx: "12", cy: "15.5", r: "1.5", fill: "currentColor", stroke: "none", key: "hub" }];

/** the effort picker's own dial on the 24 grid: a half rim from nine to three over the pivot
 * (12, 15.5). the needle spans nine to three across the choices; null draws none. */
export function Effort({ position, size }: { position: number | null; size?: number }) {
  const needle: IconNode = position === null ? [] : [["path", {
    d: "M12 15.5V8.5", transform: `rotate(${(-90 + 180 * position).toFixed(2)} 12 15.5)`, className: styles.needle, key: "needle",
  }]];
  return <LucideGlyph iconNode={[EFFORT_RIM, ...needle, EFFORT_HUB]} size={size} className={styles.effort} />;
}
