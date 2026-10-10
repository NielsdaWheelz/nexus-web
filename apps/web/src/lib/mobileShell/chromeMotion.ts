// Reading motion as a pure function of reader scroll: how far the mobile chrome
// has retreated (p: 0 shown .. 1 hidden) after the reader moved to `top`.

/** At or above this scrollTop the chrome is always shown. */
const TOP_PX = 8;
/** Movement in a new direction that moves nothing. */
const DEAD_ZONE_PX = 8;
/** Movement past the dead zone that retreats the chrome fully. */
const TRAVEL_PX = 64;

export interface Motion {
  readonly p: number;
  /** The last sampled scrollTop; null until the first sample. */
  readonly top: number | null;
  readonly direction: -1 | 0 | 1;
  /** Distance moved in `direction` since it last changed. */
  readonly run: number;
}

export const SHOWN: Motion = { p: 0, top: null, direction: 0, run: 0 };

export function baseline(top: number): Motion {
  return { p: 0, top, direction: 0, run: 0 };
}

export function scrolled(motion: Motion, top: number): Motion {
  if (top <= TOP_PX || motion.top === null) return baseline(top);
  const delta = top - motion.top;
  if (Math.abs(delta) < 1) return motion;
  const direction = delta > 0 ? 1 : -1;
  const before = direction === motion.direction ? motion.run : 0;
  const run = before + Math.abs(delta);
  const moved = Math.max(0, run - DEAD_ZONE_PX) - Math.max(0, before - DEAD_ZONE_PX);
  const p = Math.min(1, Math.max(0, motion.p + (direction * moved) / TRAVEL_PX));
  return { p, top, direction, run };
}
