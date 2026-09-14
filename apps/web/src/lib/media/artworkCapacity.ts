/**
 * UNQUALIFIED composed experiment; release requires actual browser/native and
 * workspace overlap receipts. Pixel reservations are not a process-memory proof.
 * The current player displays at most 22rem (352 CSS px; about 1056px at DPR3).
 */
export const ARTWORK_CAPACITY = {
  maxDimension: 1024,
  residentPixels: 4 * 1024 * 1024,
} as const;
