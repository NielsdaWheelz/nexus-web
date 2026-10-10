"use client";

// What a pane body contributes to its shell, and the one per-pane store it
// lands in. A body publishes by rendering (a layout effect commits it before
// paint) and withdraws by unmounting: no keys, equality or staleness guards.
// The store lives as long as the body it serves (PaneShell makes a fresh one
// when the body remounts), so a new route never reads the previous body's
// chrome; a body that stays mounted republishes in the same commit.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import type { FindController } from "@/lib/find/useFind";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import type { PaneHeaderPublication } from "@/lib/panes/paneHeaderModel";
import type {
  WorkspaceSecondaryGroupId,
  WorkspaceSecondarySurfaceIdOf,
} from "@/lib/panes/paneSecondaryModel";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";

/** Why a pane command holds its place while the fact deciding it loads. */
export const PANE_COMMAND_RESOLVING_REASON =
  "Available when this pane finishes loading.";

/** The pane search row's input cap, for filter and find alike. */
export function truncatePaneSearchQuery(query: string): string {
  return Array.from(query).slice(0, 256).join("");
}

export interface PaneFilterRowsSearch {
  readonly kind: "FilterRows";
  readonly query: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly onQueryChange: (query: string) => void;
  readonly onDismiss: () => void;
  readonly rowStatus: PaneFilterRowsStatus;
}

/**
 * `Resolving` names the control a loading pane will offer, so More keeps its
 * shape; publish it only where the loaded answer is certain to be a search.
 */
export type PaneSearch =
  | { readonly kind: "Resolving"; readonly control: "Find" | "Filter" }
  | { readonly kind: "Find"; readonly find: FindController }
  | PaneFilterRowsSearch;

export type PaneRefreshProgress =
  | { readonly kind: "Indeterminate" }
  | {
      readonly kind: "Determinate";
      readonly finishedCount: number;
      readonly requestedCount: number;
    };

export interface PaneRefreshResult {
  readonly kind: "Complete" | "Partial" | "Failed" | "ObservationLost";
  readonly announcement: string;
}

export type PaneRefreshExecute = (input: {
  readonly signal: AbortSignal;
  readonly reportProgress: (progress: PaneRefreshProgress) => void;
}) => Promise<PaneRefreshResult>;

/** `Resolving` keeps Refresh in place while the fact deciding it loads. */
export type PaneRefresh =
  | { readonly kind: "Resolving" }
  | {
      readonly kind: "Refreshable";
      readonly sourceKey: string;
      readonly execute: PaneRefreshExecute;
    };

/** The Inspector header action; the shell derives it from a published Companion. */
export type PaneCompanionAction = Extract<
  PaneHeaderAction,
  { readonly kind: "command" }
> & { readonly id: "resource-inspector-companion" };

interface PaneChromeCommon {
  readonly header?: PaneHeaderPublication;
  /** The pane's resource; its canonical actions end the More menu. */
  readonly actionSubject?: ResourceActionSubject;
  readonly menuActions?: readonly ActionDescriptor[];
  readonly refresh?: PaneRefresh;
}

/** A collection row excludes the search row and the instrument. */
export type PaneChrome = PaneChromeCommon &
  (
    | {
        readonly collection: {
          readonly label: string;
          readonly content: ReactNode;
          readonly focusInput: () => boolean;
        };
        readonly search?: never;
        readonly instrument?: never;
      }
    | {
        readonly collection?: never;
        readonly search?: PaneSearch;
        readonly instrument?: {
          readonly label: string;
          readonly content: ReactNode;
        };
      }
  );

/**
 * The pane's Companion tabs in order, all of one group. The default shows
 * while the remembered tab is unpublished.
 */
export type PaneCompanion = {
  [G in WorkspaceSecondaryGroupId]: {
    readonly groupId: G;
    readonly surfaces: readonly {
      readonly id: WorkspaceSecondarySurfaceIdOf<G>;
      readonly body: ReactNode;
    }[];
    readonly defaultSurfaceId: WorkspaceSecondarySurfaceIdOf<G>;
  };
}[WorkspaceSecondaryGroupId];

/** The reader's geometry; desktop only. */
export interface PaneLayout {
  /** A pdf's own width: the pane's minimum once known. */
  readonly intrinsicWidthPx: number | null;
  /** The overview rail beside the body. */
  readonly rail: { readonly widthPx: number; readonly body: ReactNode } | null;
}

export interface PaneChromeState {
  readonly chrome: PaneChrome | null;
  readonly companion: PaneCompanion | null;
  readonly layout: PaneLayout | null;
  /** Find's transient results in the Companion; never persisted. */
  readonly results: {
    readonly expanded: boolean;
    readonly widthPx: number;
  } | null;
}

export interface PaneChromeStore {
  get(): PaneChromeState;
  subscribe(listener: () => void): () => void;
  set(patch: Partial<PaneChromeState>): void;
  /** Where focus returns when the Companion closes: its opener or a destination. */
  returnFocus: HTMLElement | null;
}

export function createPaneChromeStore(): PaneChromeStore {
  let state: PaneChromeState = {
    chrome: null,
    companion: null,
    layout: null,
    results: null,
  };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    returnFocus: null,
  };
}

export const PaneChromeContext = createContext<PaneChromeStore | null>(null);

function usePublish<K extends "chrome" | "companion" | "layout">(
  key: K,
  value: PaneChromeState[K],
): void {
  const store = useContext(PaneChromeContext);
  // justify-defect: only PaneShell renders pane bodies.
  if (!store) throw new Error("pane chrome requires PaneShell");
  useLayoutEffect(() => {
    store.set({ [key]: value });
    return () => {
      // the last writer wins; a withdrawal clears only its own value.
      if (store.get()[key] === value) store.set({ [key]: null });
    };
  }, [store, key, value]);
}

/** A body's header, search or collection, instrument, menu and refresh. */
export function usePaneChrome(chrome: PaneChrome | null): void {
  usePublish("chrome", chrome);
}

/** A body's Companion tabs; the shell derives the Inspector action from them. */
export function usePaneCompanion(companion: PaneCompanion | null): void {
  usePublish("companion", companion);
}

/** The reader's intrinsic width and rail. */
export function usePaneLayout(layout: PaneLayout | null): void {
  usePublish("layout", layout);
}

/**
 * The shell's read of everything its body contributed. It subscribes in a
 * layout effect, which runs after the body's (a child's), so even the first
 * publication renders before the first paint; a new store is read at once.
 */
export function usePaneChromeState(store: PaneChromeStore): PaneChromeState {
  const [read, setRead] = useState(() => ({ store, state: store.get() }));
  useLayoutEffect(() => {
    const sync = () =>
      setRead((current) =>
        current.store === store && current.state === store.get()
          ? current
          : { store, state: store.get() },
      );
    sync();
    return store.subscribe(sync);
  }, [store]);
  return read.store === store ? read.state : store.get();
}
