/** New choices use one ladder; retained rates remain literal until explicitly changed. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/** Numeric distance, with the lower stop winning a tie. */
export function nearestRateIndex(rate: number): number {
  return PLAYBACK_RATES.reduce<number>((nearest, stop, index) =>
    Math.abs(stop - rate) < Math.abs(PLAYBACK_RATES[nearest] - rate) ? index : nearest, 0);
}

/** The first stop strictly past the actual rate; an endpoint sends no command. */
export function stepRate(rate: number, direction: -1 | 1): number | null {
  return (direction === 1 ? PLAYBACK_RATES.find(stop => stop > rate) : PLAYBACK_RATES.findLast(stop => stop < rate)) ?? null;
}

/** One hundredth-precision presentation for both needle and figure, never a storage write. */
export function presentPlaybackRate(rate: number): { readonly rate: number; readonly label: string } {
  const shown = Math.round(rate * 100) / 100;
  return { rate: shown, label: `${shown}×` };
}

export function formatPlaybackRate(rate: number): string {
  return presentPlaybackRate(rate).label;
}
