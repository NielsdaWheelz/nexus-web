"use client";

export type PendingNoteFocusTarget = "title" | "body";

interface PendingNoteFocus {
  pageId: string;
  target: PendingNoteFocusTarget;
}

const pendingByPageId = new Map<string, PendingNoteFocusTarget>();

export function setPendingNoteFocus(target: PendingNoteFocus): void {
  pendingByPageId.set(target.pageId, target.target);
}

export function consumePendingNoteFocus(pageId: string): PendingNoteFocusTarget | null {
  const pending = pendingByPageId.get(pageId);
  if (!pending) return null;
  pendingByPageId.delete(pageId);
  return pending;
}
