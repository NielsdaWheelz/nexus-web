import type { ReactNode } from "react";
import type {
  NexusAction,
  NexusEntry,
  NexusEntryKey,
  NexusProjection,
} from "@/lib/nexus/model";

export type DesktopNexusModality = "Keyboard" | "Pointer";
export type DesktopNexusCell = "Primary" | "Actions";

export type DesktopNexusSource = "Openables" | "Owned";

export interface DesktopNexusActionsRequest {
  readonly requestId: number;
  /** Exact entry/action snapshot captured when Nexus.Open was pressed. */
  readonly entry: NexusEntry;
}

/**
 * Desktop-only controller boundary. Semantic membership and action meaning stay
 * in the shared projection; this contract carries user intents back to the one
 * Nexus session owner.
 */
export interface DesktopNexusController {
  readonly open: boolean;
  readonly projection: NexusProjection;
  readonly query: string;
  readonly failures: ReadonlySet<DesktopNexusSource>;
  readonly busy: boolean;
  readonly announcement: string | null;
  readonly focusKey: string;
  readonly nexusOpenShortcutLabel: string;
  readonly actionsRequest: DesktopNexusActionsRequest | null;
  /** A retained workflow panel owned by the shared controller. */
  readonly workflow?: ReactNode;
  setQuery(query: string): void;
  setActiveEntry(key: NexusEntryKey): void;
  activatePrimary(input: {
    readonly entry: NexusEntry;
    readonly disposition: "Follow" | "Fork";
    readonly modality: DesktopNexusModality;
  }): void;
  activateAction(input: {
    readonly entry: NexusEntry;
    readonly action: NexusAction;
    readonly modality: DesktopNexusModality;
  }): void;
  /** The adapter calls this only after the real desktop input receives focus. */
  inputReady?(): void;
  retry(source: DesktopNexusSource): void;
  escape(): void;
  shouldSuppressReturnFocusOnClose(): boolean;
}

export interface DesktopNexusActionsOpener {
  (entry: NexusEntry, modality: DesktopNexusModality): void;
}
