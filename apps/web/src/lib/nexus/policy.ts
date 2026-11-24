// The palette's constants. Behaviour lives in rank.ts, list.ts and the controller.

/** An arrival within this many ms of paint may improve the automatic choice. */
export const ARM_WINDOW_MS = 200;
/** Arriving rows fade in over this many ms. */
export const ARRIVAL_ONSET_MS = 200;
/** A disc swipe names its destination this long; a notice, not motion, so reduced motion keeps it. */
export const SWIPE_CHIP_MS = 600;
/** A target chosen this often under one typed string owns that string's prefixes and extensions. */
export const LATCH_USES = 2;
/** Name lines shown in the block for a typed query. */
export const RESULT_CAP = 8;
/** Command lines besides the first line. */
export const DO_CAP = 2;
/** Place lines besides the first line. */
export const PLACE_CAP = 3;
/** Passage lines in the apparatus. */
export const PASSAGE_CAP = 3;
/** A waiting source stays lit for this many ms. */
export const STAR_GRACE_MS = 150;
/** A source star relights over this many ms. */
export const STAR_ONSET_MS = 200;
/** Empty apparatus lines begin ruling after this many ms. */
export const RULING_DELAY_MS = 200;
