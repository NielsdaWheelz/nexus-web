/**
 * Launcher model: the single source of truth for lane/section/item/target shapes,
 * the sigil↔lane map, the ordered section list, and the view/page state. Every
 * other launcher module derives from here. The static nav catalog lives in
 * `lib/navigation/destinations.ts`; the create/add command rows live in `providers.ts`.
 */

import type { ComponentType } from "react";
import type { BrowseResult } from "@/lib/browse/types";
import type { ResourceActivation } from "@/lib/resources/activation";

export type LauncherLane =
  | "all" // blended default — show all interpretations
  | "open" // existing resources: context, open tabs, recents, folios
  | "search" // in-library search (shared SearchQuery)
  | "browse" // external discovery (/api/browse + /api/web/search)
  | "add" // add URL / upload file / import OPML
  | "create" // create note / page
  | "ask" // ask AI
  | "go"; // commands: navigate + settings

// Sigils for the common lanes; every lane is also reachable via the visible chip row.
// `search`/`browse`/`create` have no sigil (search is implicit in `all`; the rest use
// chips/rows) to avoid sigil sprawl. LauncherInput re-prefixes from this map and
// parseLauncherInput inverts it, so a glyph change can never desync chip from parse.
export const LANE_SIGIL: Partial<Record<LauncherLane, string>> = {
  go: ">",
  open: "@",
  ask: "?",
  add: "+",
};

// The selectable lanes in chip-row order; the blended `all` is the cleared (no-chip)
// state. Single owner for the lane labels (chip row + active-lane pill).
export const SELECTABLE_LANES: Exclude<LauncherLane, "all">[] = [
  "open",
  "search",
  "browse",
  "add",
  "create",
  "ask",
  "go",
];

export const LANE_LABEL: Record<Exclude<LauncherLane, "all">, string> = {
  open: "Open",
  search: "Search",
  browse: "Browse",
  add: "Add",
  create: "Create",
  ask: "Ask",
  go: "Go to",
};

export type LauncherSectionId =
  | "context"
  | "open-tabs"
  | "recent"
  | "recent-folios" // → open
  | "search-results" // → search
  | "browse-results" // → browse
  | "add" // → add
  | "create" // → create
  | "go"
  | "settings" // → go
  | "ask"; // → ask

// `source` is the backend palette-selections wire enum; href/resource selections are
// posted verbatim (command_palette.py). "browse" rows are never logged (no stable key).
export type LauncherSource =
  | "static"
  | "workspace"
  | "recent"
  | "oracle"
  | "search"
  | "browse"
  | "ai";

export type LauncherIcon = ComponentType<{
  size?: number;
  "aria-hidden"?: boolean | "true" | "false";
}>;

// Stable DOM ids shared by the input (aria-controls / aria-activedescendant), the
// listbox, and the rows. Renamed from the palette contract (documented breaking change).
export const LAUNCHER_LISTBOX_ID = "launcher-listbox";
export const LAUNCHER_OPTION_ID_PREFIX = "launcher-option-";

export interface AddSeed {
  mode: "url" | "file" | "opml";
}

// Terminal targets: dispatchTarget executes exactly one of these (one open seam, AC-9).
export type LauncherActionTarget =
  | { kind: "href"; href: string; externalShell: boolean; labelHint?: string }
  | { kind: "resource"; activation: ResourceActivation; labelHint?: string }
  | { kind: "ask"; text: string }
  | { kind: "add-url"; url: string } // quick add from the hard-signal row
  | { kind: "queue-add"; mediaId: string; title: string } // append media to the Lectern
  | { kind: "create-note"; text: string } // quick capture → daily note
  | { kind: "browse-acquire"; result: BrowseResult } // open if owned, else add by url
  | { kind: "new-conversation" }
  | { kind: "create-page" } // create an empty page then open it
  | { kind: "copy-link"; href: string }
  | { kind: "pane-open"; paneId: string } // activate, restoring if minimized
  | { kind: "pane-close"; paneId: string }
  | { kind: "open-today" } // resolve-or-create today's daily page then open it
  | { kind: "set-lane"; lane: LauncherLane; query?: string }; // switch lane in-place (controller intercepts, never dispatched)

// Panel targets: the controller intercepts these to push an embedded page (not dispatch).
export type LauncherPanelTarget =
  | { kind: "open-add"; seed: AddSeed }
  | { kind: "open-create" };

export type LauncherTarget = LauncherActionTarget | LauncherPanelTarget;

export interface LauncherRankSignals {
  searchScore?: number;
  frecencyBoost?: number;
  scopeBoost?: number;
}

export interface LauncherItem {
  id: string;
  title: string;
  subtitle?: string;
  keywords: string[];
  sectionId: LauncherSectionId; // also determines lane membership (inLane)
  icon: LauncherIcon;
  target: LauncherTarget;
  source: LauncherSource;
  rank: LauncherRankSignals;
  shortcutLabel?: string;
  hasActions?: boolean; // row drills into an actions page
  pin?: "last"; // sinks to the end of the querying list (ask / create / browse / see-all)
  trailingAction?: { target: LauncherActionTarget; ariaLabel: string };
}

export interface LauncherSection {
  id: LauncherSectionId;
  label: string;
  cap: number; // max rows shown in the resting group
}

// Ordered; the resting view groups by this order and skips empty sections.
export const SECTIONS: LauncherSection[] = [
  { id: "context", label: "Continue", cap: 1 },
  { id: "open-tabs", label: "Open tabs", cap: 6 },
  { id: "recent", label: "Recent", cap: 6 },
  { id: "recent-folios", label: "Recent folios", cap: 5 },
  { id: "search-results", label: "Search results", cap: 6 },
  { id: "browse-results", label: "Browse", cap: 6 },
  { id: "add", label: "Add", cap: 8 },
  { id: "create", label: "Create", cap: 8 },
  { id: "go", label: "Go to", cap: 12 },
  { id: "settings", label: "Settings", cap: 8 },
  { id: "ask", label: "Ask", cap: 1 },
];

export interface LauncherAction {
  id: string;
  label: string;
  icon: LauncherIcon;
  shortcutLabel?: string;
  target: LauncherActionTarget; // the first action is the item's default (Enter/select)
}

export interface LauncherGroup {
  sectionId: LauncherSectionId;
  label: string;
  items: LauncherItem[];
}

export type LauncherView =
  | { state: "resting"; groups: LauncherGroup[] }
  | { state: "querying"; results: LauncherItem[] }
  | { state: "actions"; item: LauncherItem; actions: LauncherAction[] };

export type LauncherPage =
  | { kind: "root" }
  | { kind: "actions"; item: LauncherItem; actions: LauncherAction[] }
  | { kind: "add"; seed: AddSeed }
  | { kind: "create" };

// Ordered ids of the selectable rows in a view — items at root, actions when drilled.
// Used for arrow-nav and to keep the active row valid across view changes.
export function launcherRowIds(view: LauncherView): string[] {
  switch (view.state) {
    case "resting":
      return view.groups.flatMap((group) => group.items.map((item) => item.id));
    case "querying":
      return view.results.map((item) => item.id);
    case "actions":
      return view.actions.map((action) => action.id);
  }
}

// The focused LauncherItem in a root (resting|querying) view, falling back to the top
// row. Undefined on the actions page (its rows are LauncherActions, not items).
export function activeLauncherItem(
  view: LauncherView,
  activeId: string | null,
): LauncherItem | undefined {
  const items =
    view.state === "resting"
      ? view.groups.flatMap((group) => group.items)
      : view.state === "querying"
        ? view.results
        : [];
  return items.find((item) => item.id === activeId) ?? items[0];
}
