// The dossier controller's client state. Wire values are the generated
// `Schema<…>` types (docs/local-rules/typed-wire.md), read where they are used.
import type { Schema } from "@/lib/api/wire";

/** The Media dossier's abstract: the one wire union without a generated name. */
export type MediaAbstract = Extract<
  Schema<"DossierHeadOut">["media_abstract"],
  { kind: "Present" }
>["value"];

/** A same-system API or transport error, kept for `dossierErrorMessage`. */
export interface DossierErrorInfo {
  code: string;
  message: string;
}

export type DossierHead =
  | { kind: "Idle" }
  | { kind: "Loading" }
  | { kind: "Failed"; error: DossierErrorInfo }
  | { kind: "Ready"; ready: Schema<"DossierHeadOut"> };

/**
 * The persisted terminal event observed by this client. It stays separate from
 * the head so terminal UI settles at once even when the follow-up head read is
 * slow or fails.
 */
export type DossierTerminalOutcome =
  | { kind: "Succeeded"; artifactRevisionRef: string }
  | { kind: "Failed"; buildHandle: string; facts: Schema<"FailedEventPayload"> }
  | {
      kind: "Cancelled";
      buildHandle: string;
      facts: Schema<"CancelledEventPayload">;
    };

export type DossierStream =
  | { kind: "Disconnected" }
  | { kind: "Connecting" }
  | { kind: "Live" }
  | { kind: "Reconnecting" }
  | { kind: "Suspended" }
  | {
      kind: "Terminal";
      outcome: DossierTerminalOutcome;
      /** The head has absorbed this event's exact result. */
      reconciled: boolean;
    };

/** The in-flight command: drives control busy state and the near-control error. */
export type DossierPendingAction = "generate" | "cancel" | null;

/** The whole controller snapshot, replaced (never mutated) on every change, so
 * its identity is a sound `useSyncExternalStore` change signal. */
export interface DossierControllerState {
  head: DossierHead;
  stream: DossierStream;
  /** The active build's last `Progress` message (polite status region). */
  progressMessage: string | null;
  pendingAction: DossierPendingAction;
  actionError: DossierErrorInfo | null;
  instructionDraft: string;
}

export function initialDossierControllerState(): DossierControllerState {
  return {
    head: { kind: "Idle" },
    stream: { kind: "Disconnected" },
    progressMessage: null,
    pendingAction: null,
    actionError: null,
    instructionDraft: "",
  };
}
