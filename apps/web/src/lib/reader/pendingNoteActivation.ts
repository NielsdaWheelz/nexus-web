"use client";

import type { NotePulseTarget } from "./pulseEvent";

/**
 * App-level handoff for a note-citation activation that must survive the mount
 * of its target notes pane.
 *
 * Clicking a `[N]` note citation in chat dispatches a {@link NotePulseTarget}
 * for the already-open-on-this-page case, then navigates. When the cited page
 * is NOT already open, the target pane has not mounted its
 * `useNotePulseHighlight` listener yet, so the live event is lost. The activator
 * therefore also `set`s the target here before navigating; the target
 * `PagePaneBody` `consume`s it on mount (clearing it) and applies its own
 * scroll+pulse retry loop, which already tolerates the editor still mounting.
 *
 * Keyed by `pageId` so an activation for one page is never consumed by an
 * unrelated page pane. Last-write-wins per page: only the most recent pending
 * activation matters, exactly like the reader's deferred-pulse ref.
 */
const pendingByPageId = new Map<string, NotePulseTarget>();

export function setPendingNoteActivation(target: NotePulseTarget): void {
  pendingByPageId.set(target.pageId, target);
}

/**
 * Take and clear the pending activation for `pageId`, if any. Returns `null`
 * when there is none so a later genuine same-pane pulse event still works.
 */
export function consumePendingNoteActivation(
  pageId: string,
): NotePulseTarget | null {
  const pending = pendingByPageId.get(pageId);
  if (!pending) return null;
  pendingByPageId.delete(pageId);
  return pending;
}
