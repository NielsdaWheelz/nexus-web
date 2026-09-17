"use client";

export type PendingNoteFocusTarget = "title" | "body";

const pendingByPageId = new Map<string, PendingNoteFocusTarget>();

export function setPendingNoteFocus(pageId: string, target: PendingNoteFocusTarget): void {
  pendingByPageId.set(pageId, target);
}

export function consumePendingNoteFocus(pageId: string): PendingNoteFocusTarget | null {
  const pending = pendingByPageId.get(pageId);
  if (!pending) return null;
  pendingByPageId.delete(pageId);
  return pending;
}
