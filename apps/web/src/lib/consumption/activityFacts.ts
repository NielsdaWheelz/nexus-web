// Numeric facts guaranteed by their source, so presenters never take unchecked numbers.

/** Finite, within [0, 1]. */
export type ProgressFraction = { readonly value: number };
/** An integer >= 1. */
export type PositiveMinutes = { readonly value: number };
/** An integer >= 0. */
export type NonNegativeMinutes = { readonly value: number };
/** An integer >= 1. */
export type PositiveCount = { readonly value: number };
