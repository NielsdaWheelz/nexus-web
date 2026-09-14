import type { ReaderCursorSnapshot, ReaderCursorSource } from "./readerProgress";
import type { SelectedReaderSource } from "./readerIntentStore";
import type { MediaId } from "./ReaderDocumentSource";
import type { ReaderResumeState } from "./types";

export type ReaderProgressView =
  | { readonly kind: "Canonical"; readonly snapshot: ReaderCursorSnapshot }
  | {
      readonly kind: "Pending";
      readonly source: SelectedReaderSource;
      readonly baseline: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    }
  | {
      readonly kind: "Conflict";
      readonly source: SelectedReaderSource;
      readonly canonical: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    }
  | {
      readonly kind: "ContentChanged";
      readonly source: ReaderCursorSource;
      readonly baseline: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    }
  | {
      readonly kind: "SourceUnavailable";
      readonly source: ReaderCursorSource;
      readonly baseline: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    };

export type ReaderProgressSaveResult =
  | Extract<ReaderProgressView, { kind: "Canonical" | "Conflict" }>
  | { readonly kind: "DurablyPending"; readonly view: Extract<ReaderProgressView, { kind: "Pending" }> }
  | { readonly kind: "ContentChanged"; readonly view: Extract<ReaderProgressView, { kind: "ContentChanged" }> }
  | { readonly kind: "SourceUnavailable"; readonly view: Extract<ReaderProgressView, { kind: "SourceUnavailable" }> };

export interface ReaderProgressPort {
  /** One selected publication or timeline per reader visit. */
  bindSource(mediaId: MediaId, source: SelectedReaderSource): void;
  /** Register the live reader; release retains and delivers its captured intent. */
  attach(): () => void;
  load(mediaId: MediaId, signal?: AbortSignal): Promise<ReaderProgressView>;
  /** Resolve only after the local durable transaction commits. */
  capture(mediaId: MediaId, locator: ReaderResumeState): Promise<ReaderProgressSaveResult>;
  /** Deliver captured work, or observe the native owner's current delivery outcome. */
  flush(mediaId: MediaId, options?: { readonly keepalive?: boolean }): Promise<ReaderProgressSaveResult>;
  resolve(mediaId: MediaId, choice: "Canonical" | "Device"): Promise<ReaderProgressView>;
}
