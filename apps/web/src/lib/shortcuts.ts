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

export const PANE_STRIP_DESCRIPTION = "Arrow keys browse tabs. Enter opens. Down opens actions. Delete closes. Shift+M maximizes or restores.";

// These keys belong to the focused toolbar control, not the app-wide matcher.
export const PANE_STRIP_SHORTCUTS = [
  {
    id: "PaneStrip.Browse",
    title: "Browse tab titles",
    description: "Moves focus through all tabs, including minimized panes. Wraps at either end without activating a pane.",
    meta: "← / →",
  },
  {
    id: "PaneStrip.Edge",
    title: "First or last tab",
    description: "Focuses the first or last tab title without activating it.",
    meta: "Home / End",
  },
  {
    id: "PaneStrip.Open",
    title: "Open tab",
    description: "Activates the focused tab, restores it if minimized, and moves focus into its pane.",
    meta: "Enter / Space",
  },
  {
    id: "PaneStrip.Actions",
    title: "Open tab actions",
    description: "Opens actions for the focused tab. Escape returns to its menu button; Tab or Shift+Tab leaves the strip.",
    meta: "↓ / Shift+F10 / Context Menu",
  },
  {
    id: "PaneStrip.Close",
    title: "Close tab",
    description: "Closes the focused tab once per press. The resource remains available.",
    meta: "Delete / Backspace",
  },
  {
    id: "PaneStrip.Maximize",
    title: "Maximize or restore layout",
    description: "Maximizes the focused tab, or restores the canvas when that pane is already maximized. Focus stays in the strip.",
    meta: "Shift+M",
  },
] as const;

type Shortcut = (typeof SHORTCUTS)[keyof typeof SHORTCUTS];

function usesMeta(platform: PlatformKind): boolean {
  return platform === "mac" || platform === "ios";
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
