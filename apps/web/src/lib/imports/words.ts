/** shared import words without runtime or UI dependencies: the app and extension
 * use one spelling without loading the app into the background page. */
export const IMPORT_WORDS = {
  changed: "something changed while this was sending.",
  deleting: "this is being removed",
  tooBig: "the file is too big",
  integrity: "what arrived doesn’t match the file",
  refused: "nexus refused it",
  notPrepared: "couldn’t start the upload",
  timedOut: "upload timed out",
  stopped: "upload stopped",
  notChecked: "couldn’t check the file",
} as const;
