/**
 * Source-owned numeric facts used by consumption projections. These wrappers
 * make it impossible for collection presenters to accept unchecked numbers.
 */

/** Source-decoder guarantee: finite and in the inclusive range [0, 1]. */
export interface ProgressFraction {
  readonly value: number;
}

/** Source-decoder or source-owned derivation guarantee: integer >= 1. */
export interface PositiveMinutes {
  readonly value: number;
}

/** Source-decoder or source-owned derivation guarantee: integer >= 1. */
export interface PositiveCount {
  readonly value: number;
}
