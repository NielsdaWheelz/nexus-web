import type { ReactNode } from "react";

export interface DesktopNexusSnippetSegment {
  readonly text: string;
  readonly emphasized: boolean;
}

export type DesktopNexusModality = "Keyboard" | "Pointer";

/**
 * Desktop-only presentation contract. The shared Nexus controller maps its
 * domain entries into this deliberately small view at the boundary; desktop
 * markup never infers an owner, action, or activation from displayed text.
 */
export interface DesktopNexusEntry {
  readonly key: string;
  readonly label: string;
  /** A factual type label, such as `Page` or `Highlight`; absent means omit. */
  readonly typeLabel?: string;
  /** Existing owner or source fact; absent means omit. */
  readonly metadata?: string;
  /** Existing matched excerpt; no generated summaries belong here. */
  readonly excerpt?: string;
  /** Existing matched excerpt segments; rendering stays text-only. */
  readonly excerptSegments?: readonly DesktopNexusSnippetSegment[];
  /** Only emitted when the entry is already an open workspace pane. */
  readonly open?: boolean;
  /** Serialized canonical-owner/open-pane identity, never this entry's key. */
  readonly parentKey?: string;
  /** Existing-fact group label when the parent is not itself rendered. */
  readonly parentLabel?: string;
  readonly icon: ReactNode;
  readonly hasSecondaryActions: boolean;
}

export interface DesktopNexusAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
}

export interface DesktopNexusWebResult {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly excerpt?: string;
}

export type DesktopNexusSource = "Openables" | "Owned";

export type DesktopNexusPage =
  | { readonly kind: "Root" | "Find" }
  | { readonly kind: "Actions"; readonly label: string; readonly actions: readonly DesktopNexusAction[] }
  | {
      readonly kind: "WebSearch";
      readonly query: string;
      readonly status: "Idle" | "Loading" | "Ready" | "RetryableFailure";
      readonly results: readonly DesktopNexusWebResult[];
    };

export interface DesktopNexusController {
  readonly open: boolean;
  readonly page: DesktopNexusPage;
  readonly query: string;
  readonly entries: readonly DesktopNexusEntry[];
  readonly activeEntryKey: string | null;
  readonly activeWebResultId: string | null;
  readonly failures: ReadonlySet<DesktopNexusSource>;
  readonly busy: boolean;
  readonly focusKey: string;
  /** A retained workflow panel owned by the shared controller. */
  readonly workflow?: ReactNode;
  setQuery(query: string): void;
  setWebQuery(query: string): void;
  setActiveEntry(key: string): void;
  setActiveWebResult(id: string): void;
  selectEntry(
    key: string,
    disposition: "Follow" | "Fork",
    modality: DesktopNexusModality,
  ): void;
  openActions(): void;
  runAction(actionId: string): void;
  selectWebResult(
    id: string,
    disposition: "Follow" | "Fork",
    modality: DesktopNexusModality,
  ): void;
  /** The adapter calls this only after the real desktop input receives focus. */
  inputReady?(): void;
  retry(source: DesktopNexusSource | "Web"): void;
  back(): void;
  escape(): void;
  shouldSuppressReturnFocusOnClose(): boolean;
}
