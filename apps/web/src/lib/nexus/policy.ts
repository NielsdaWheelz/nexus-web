// The palette's constants. Behaviour lives in rank.ts, list.ts and the controller.

/** An arrival within this many ms of the paint may re-arm the best row. */
export const ARM_WINDOW_MS = 200;
/** An armed row counts as seen after this many ms; enter before that fires the remembered row. */
export const PERCEIVED_MS = 120;
/** Arriving rows fade in over this many ms. */
export const ARRIVAL_ONSET_MS = 200;
/** A target chosen this often under one typed string owns that string's prefixes and extensions. */
export const LATCH_USES = 2;
/** Principal rows shown for a typed query. */
export const RESULT_CAP = 8;
/** Verb chips before `more`, the fixed pair included. */
export const RAIL_CHIPS = 4;
/** Read verbs the rail prefers after the fixed pair, in order; everything else stays in `more`. */
export const RAIL_VERBS: readonly string[] = [
  "Nexus.OpenMatchingPassage", "Nexus.ShowExcerpt", "Playback", "LecternMembership", "SubscribePodcast",
  "UnsubscribePodcast", "EditHighlightAnnotation", "EditNoteBody", "ForkMessage", "AddUnfinishedToLectern",
  "RefreshPodcast", "Chat", "Consumption", "EditPageTitle", "RegenerateMessage", "RerunMessage",
  "PodcastLibraries", "LibraryPlacement", "Share", "Transcript", "LibrarySettings", "PodcastSettings", "Metadata",
];
