"use client";

/**
 * A one-shot "focus the search box" request. The Launcher sets it when it navigates
 * to the search surface (the "Go to Authors" / "Search" commands and their
 * keybindings); SearchPaneBody consumes it the first time it mounts enabled.
 *
 * This mirrors pendingNoteFocus: the navigator declares the intent so the
 * destination can focus its input WITHOUT stealing focus on ordinary arrivals —
 * first-paint pane restore, Back/Forward, or a results URL the user did not just
 * ask to type into. SearchPaneBody additionally focuses only when the landing query
 * is blank, so a navigation carrying text never yanks focus into the box.
 */

let pending = false;

export function requestSearchInputFocus(): void {
  pending = true;
}

export function consumeSearchInputFocus(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}
