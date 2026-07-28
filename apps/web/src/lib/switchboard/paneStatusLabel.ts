/**
 * The one status label for an open workspace pane row shown across the
 * Switchboard root, the launcher owner-pane rows, and mobile local Find.
 */
export function paneStatusLabel(pane: {
  current: boolean;
  visibility: "visible" | "minimized";
}): string {
  if (pane.current) return "Active tab";
  return pane.visibility === "minimized" ? "Minimized" : "Open tab";
}
