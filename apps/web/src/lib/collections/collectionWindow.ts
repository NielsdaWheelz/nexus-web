/** Uniform measured rows: one viewport of overscan on either side, sparse
 * neighboring pins, and rank gaps. Neither geometry nor scroll has an owner here. */
export function windowRange({ top, viewport, height, count }: {
  readonly top: number;
  readonly viewport: number;
  readonly height: number;
  readonly count: number;
}) {
  return {
    start: Math.max(0, Math.min(count, Math.floor((top - viewport) / height))),
    end: Math.max(0, Math.min(count, Math.ceil((top + 2 * viewport) / height))),
  };
}

export function windowRanks({ start, end, count, pinnedRanks, retainedRanks = [] }: {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly pinnedRanks: readonly number[];
  readonly retainedRanks?: readonly number[];
}) {
  const demand = new Set<number>();
  for (let index = start; index < end; index += 1) demand.add(index);
  for (const index of pinnedRanks) {
    for (let rank = Math.max(0, index - 1); rank <= Math.min(count - 1, index + 1); rank += 1) demand.add(rank);
  }
  for (const index of retainedRanks) {
    if (index >= 0 && index < count) demand.add(index);
  }
  const mounted = new Set(demand);
  if (count > 0) { mounted.add(0); mounted.add(count - 1); }
  const ranks = [...mounted].sort((left, right) => left - right);
  return {
    rows: ranks.map((index, position) => ({ index,
      gap: index - (position === 0 ? 0 : ranks[position - 1] + 1) })),
    demand: [...demand],
  };
}
