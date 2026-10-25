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
