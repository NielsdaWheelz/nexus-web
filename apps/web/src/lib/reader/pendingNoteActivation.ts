"use client";

import type { NotePulseTarget } from "./pulseEvent";

/**
 * App-level handoff for a note-citation activation that must survive the mount.
 *
 * Clicking a `[N]` note citation in chat dispatches a {@link NotePulseTarget}
 * for already-open surfaces, then navigates to `/notes/{blockId}`. The target
 * pane may not have mounted its `useNotePulseHighlight` listener yet, so the
 * activator also stores the target here for the note pane to consume.
 *
 * Keyed by `blockId` so activation follows note identity, not containment.
 */
const pendingByBlockId = new Map<string, NotePulseTarget>();

export function setPendingNoteActivation(target: NotePulseTarget): void {
  pendingByBlockId.set(target.blockId, target);
}

export function consumePendingNoteActivation(
  blockId: string,
): NotePulseTarget | null {
  const pending = pendingByBlockId.get(blockId);
  if (!pending) return null;
  pendingByBlockId.delete(blockId);
  return pending;
}
