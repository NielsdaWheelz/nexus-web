import type { PlatformKind } from "@/lib/renderEnvironment/types";

// fixed app shortcuts; each feature owns when its action is available.
export const SHORTCUTS = {
  "Nexus.Open": {
    label: "Open Nexus",
    description: "Opens Nexus and focuses its query. An open desktop palette keeps its current state.",
    key: "k",
    shift: false,
  },
  "Pane.Search": {
    label: "Search this pane",
    description: "Searches the active pane when available; otherwise uses browser find.",
    key: "f",
    shift: false,
  },
  "pane-next": {
    label: "Next pane",
    description: "Moves to the next visible pane, except while typing or using a menu or dialog.",
    key: "ArrowRight",
    shift: true,
  },
  "pane-previous": {
    label: "Previous pane",
    description: "Moves to the previous visible pane, except while typing or using a menu or dialog.",
    key: "ArrowLeft",
    shift: true,
  },
} as const;

export const NEW_PANE_HINT = "shift-click or shift-enter opens in a new pane";

export const PANE_STRIP_DESCRIPTION = "left/right browse pane titles and controls. home/end reach the first/last control. enter or space activates. shift+enter opens the focused title's page in a new pane. tab leaves the strip. delete closes the focused pane. shift+m maximizes or restores layout.";

// These keys belong to the focused toolbar control, not the app-wide matcher.
export const PANE_STRIP_SHORTCUTS = [
  {
    id: "PaneStrip.Browse",
    title: "Browse pane titles and controls",
    description: "Moves focus through titles and controls, including minimized panes and disabled minimize. Wraps at either end without activating a pane.",
    meta: "← / →",
  },
  {
    id: "PaneStrip.Edge",
    title: "First or last control",
    description: "Focuses the first title or last close control without activating it.",
    meta: "Home / End",
  },
  {
    id: "PaneStrip.Open",
    title: "Activate title or control",
    description: "A title selects its pane and enters its content. Shift-click or Shift+Enter on a title opens its current page in a new pane. A management control keeps focus in the strip.",
    meta: "Enter / Space",
  },
  {
    id: "PaneStrip.Leave",
    title: "Leave the strip",
    description: "Tab or Shift+Tab leaves from the current roving control.",
    meta: "Tab / Shift+Tab",
  },
  {
    id: "PaneStrip.Close",
    title: "Close pane",
    description: "Closes the focused pane once per press. The resource remains available.",
    meta: "Delete / Backspace",
  },
  {
    id: "PaneStrip.Maximize",
    title: "Maximize or restore layout",
    description: "Maximizes the focused pane, or restores the canvas when that pane is already maximized. Focus stays in the strip.",
    meta: "Shift+M",
  },
] as const;

/** The outline's local editing grammar; these are not app-wide shortcuts. */
export function outlineShortcuts(platform: PlatformKind): readonly {
  id: string; title: string; description: string; meta: string;
}[] {
  return [
    {id: "Outline.Select", title: "select a block", description: "escape from note text selects its block. space selects a focused block. on touch screens, hold its bullet and choose select block.", meta: "Esc / Space"},
    {id: "Outline.Browse", title: "browse blocks", description: "from a selected block, arrows follow the visible outline, including expanded children. shift extends the selection.", meta: "↑ / ↓"},
    {id: "Outline.Insert", title: "insert or split a block", description: "return splits note text at the caret or inserts after a selected block. on an empty nested note it outdents; an empty root note stays put.", meta: "Enter"},
    {id: "Outline.LineBreak", title: "insert a line break", description: "starts another line within the same note. return inside code also stays in the note.", meta: "Shift+Enter"},
    {id: "Outline.Indent", title: "indent or outdent", description: "nests the block under the one above it, or moves it out a level. an unavailable move leaves the caret in place.", meta: "Tab / Shift+Tab"},
    {id: "Outline.Move", title: "move a block up or down", description: "moves the block past its sibling. editing keeps the caret at the same text position.", meta: usesMeta(platform) ? "⌘⇧↑ / ⌘⇧↓" : "Alt+Shift+↑ / Alt+Shift+↓"},
    {id: "Outline.History", title: "undo or redo", description: "undoes or redoes the last change in this outline, including writing and block changes.", meta: usesMeta(platform) ? "⌘Z / ⌘⇧Z" : "Ctrl+Z / Ctrl+Shift+Z"},
    {id: "Outline.Delete", title: "join or remove a block", description: "at a note boundary, joins an adjacent note. an empty note or selected block is unlinked; the resource remains. undo restores the change.", meta: "Backspace / Delete"},
    {id: "Outline.Clear", title: "clear block selection", description: "clears the selection and returns focus to the bullet. tab then moves on.", meta: "Esc"},
  ];
}

type Shortcut = (typeof SHORTCUTS)[keyof typeof SHORTCUTS];

export function usesMeta(platform: PlatformKind): boolean {
  return platform === "mac" || platform === "ios";
}

/** The same primary-modifier undo/redo grammar for text and selected blocks. */
export function outlineHistoryCommand(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "altKey" | "ctrlKey">,
  platform: PlatformKind,
): "undo" | "redo" | null {
  const primary = usesMeta(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey) return null;
  const key = event.key.toLowerCase();
  return key === "z" ? event.shiftKey ? "redo" : "undo" : key === "y" && !event.shiftKey ? "redo" : null;
}

/** Tab/Shift+Tab and the move chord. Any extra modifier disqualifies. */
export function outlineStructuralCommand(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "altKey" | "ctrlKey">,
  platform: PlatformKind,
): "indent" | "outdent" | "move_up" | "move_down" | null {
  if (event.key === "Tab")
    return event.metaKey || event.ctrlKey || event.altKey ? null : event.shiftKey ? "outdent" : "indent";
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
  const chord = usesMeta(platform) ? event.metaKey && !event.altKey : event.altKey && !event.metaKey;
  if (!chord || !event.shiftKey || event.ctrlKey) return null;
  return event.key === "ArrowUp" ? "move_up" : "move_down";
}

export function matchesShortcut(
  shortcut: Shortcut,
  event: KeyboardEvent,
  platform: PlatformKind,
): boolean {
  const meta = usesMeta(platform);
  return !event.defaultPrevented && !event.isComposing &&
    event.metaKey === meta && event.ctrlKey === !meta &&
    !event.altKey && event.shiftKey === shortcut.shift &&
    event.key.toLowerCase() === shortcut.key.toLowerCase();
}

export function formatShortcut(shortcut: Shortcut, platform: PlatformKind): string {
  const key = shortcut.key === "ArrowRight" ? "→"
    : shortcut.key === "ArrowLeft" ? "←" : shortcut.key.toUpperCase();
  return usesMeta(platform)
    ? `⌘${shortcut.shift ? "⇧" : ""}${key}`
    : `Ctrl+${shortcut.shift ? "Shift+" : ""}${key}`;
}

export function shortcutAriaKeys(shortcut: Shortcut, platform: PlatformKind): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return `${usesMeta(platform) ? "Meta" : "Control"}+${shortcut.shift ? "Shift+" : ""}${key}`;
}
