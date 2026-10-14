import type { PlatformKind } from "@/lib/renderEnvironment/types";

// fixed app shortcuts; each feature owns when its action is available.
export const SHORTCUTS = {
  "Nexus.Open": {
    label: "Open Nexus",
    description: "In Nexus, opens the selected result’s actions when available.",
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
