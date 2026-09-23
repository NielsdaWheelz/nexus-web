// The extension runtime contract, docs/extension-firefox-v1-freeze.md §8 verbatim: types only.
// background.ts (track b) writes view state and answers commands; popup.tsx (track c) reads them.

import type {
  LibraryDestinationPage,
  LibraryDestinationSelection,
} from "@/lib/libraries/destinationContract";

export type CaptureTargetView =
  | {
      kind: "article";
      /** article title; never empty (falls back to the url) */
      title: string;
      /** hostname only; signed query parameters are never displayed */
      host: string;
      /** bounded inert plain text (≤ 1200 chars) for the optional preview */
      previewText: string;
    }
  | {
      kind: "document";
      /** link label or filename; never empty */
      title: string;
      host: string;
      /** "unknown" until the bounded get classified the bytes */
      documentKind: "unknown" | "pdf" | "epub";
    };

export interface CaptureAccount { userHandle: string; email: string | null; displayName: string | null }

export interface CaptureFailure { code: string; message: string; requestId: string | null }

export type CapturePhase =
  | { kind: "draft" }
  | { kind: "acquiring" }
  | { kind: "prepared" }
  | { kind: "transferring" }
  | { kind: "confirming" }
  | { kind: "saved"; mediaId: string; openUrl: string; reused: boolean }
  | { kind: "failed"; failure: CaptureFailure; retryable: boolean };

export interface CaptureDraftView {
  id: string;
  target: CaptureTargetView;
  phase: CapturePhase;
  /** selected additional libraries; empty is valid */
  destinations: readonly LibraryDestinationSelection[];
  /** match patterns the popup must request before "save" (nexus, storage, and the
      target origin in document mode); already-granted origins are omitted */
  requiredOrigins: readonly string[];
  /** true after browser restart: the popup shows explicit "resume" before any network work */
  resumable: boolean;
}

export type CaptureConnection =
  | { kind: "signed_out" }
  | { kind: "connected"; account: CaptureAccount }
  | { kind: "revocation_failed"; failure: CaptureFailure };

export type CaptureViewState = {
  connection: CaptureConnection;
  view:
    | { kind: "empty" }                                   // no draft, nothing pinned
    | { kind: "unsupported"; reason: string }             // internal scheme, no tab, …
    | { kind: "draft"; draft: CaptureDraftView };
};

/** popup → background. every command answers `CommandResult`. */
export type CaptureCommand =
  | { kind: "activate" }                       // popup opened by toolbar: pin active tab if no draft is active
  | { kind: "resume" }                         // explicit resume of a restart-recovered draft
  | { kind: "set_destinations"; destinations: readonly LibraryDestinationSelection[] }
  | { kind: "search_destinations"; q: string; cursor: string | null }
  | { kind: "login" }                          // hosted login; background refocuses window and reopens the popup
  | { kind: "save" }                           // popup has already requested `requiredOrigins`
  | { kind: "retry" }                          // same operation key; no new identity
  | { kind: "discard" }
  | { kind: "disconnect" };                    // confirmed revocation only forgets the credential

export type CommandResult =
  | { kind: "state"; state: CaptureViewState }
  | { kind: "page"; state: CaptureViewState; page: LibraryDestinationPage }   // search_destinations only
  | { kind: "failure"; failure: CaptureFailure; state: CaptureViewState };

/** background → popup push over `runtime.connect({ name: "nexus-capture-view" })` */
export type CaptureViewMessage = { kind: "state"; state: CaptureViewState };
