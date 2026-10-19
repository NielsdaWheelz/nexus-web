// What a host plugs into the reader: where the publication comes from, where
// the cursor persists, and what the host holds while the reader positions.
import type { CursorSnapshot, Locator, PdfFile, ReaderDocument } from "./model";

export interface ReaderSource {
  /** One immutable source publication with its current title and embedded-child presentation. */
  load(signal: AbortSignal): Promise<ReaderDocument>;
  /** pdf: a fresh file after a failed fetch (hosted re-signs; shelf and public return the same file). */
  refreshPdf(signal: AbortSignal): Promise<PdfFile>;
  /** An optional dom pass over each unit once mounted (public: token-authorised images). */
  hydrate?(unit: HTMLElement, signal: AbortSignal): void;
}

export type ProgressView =
  | { readonly kind: "Canonical"; readonly snapshot: CursorSnapshot }
  | {
      readonly kind: "Pending" | "ContentChanged" | "SourceUnavailable";
      readonly baseline: CursorSnapshot;
      readonly device: Locator;
      readonly adoptUnresolved: boolean;
    }
  | {
      readonly kind: "Conflict";
      readonly canonical: CursorSnapshot;
      readonly device: Locator;
      readonly adoptUnresolved: boolean;
    };
export type ProgressSaveResult =
  | { readonly kind: "ContentChanged" }
  | { readonly kind: "Canonical"; readonly snapshot: CursorSnapshot }
  /** Refused: canonical moved past the base (hosted 409). The reader offers the newer spot. */
  | { readonly kind: "Stale"; readonly canonical: CursorSnapshot }
  /** Kept by a device store, which never refuses: its view after the write. */
  | { readonly kind: "Device"; readonly view: ProgressView };

/** Bound to one media at construction. The sync owns the base revision; ports hold no baselines. */
export interface ReaderProgressPort {
  load(signal?: AbortSignal): Promise<ProgressView>;
  save(
    locator: Locator,
    base: { readonly revision: number; readonly keepalive: boolean; readonly expectedReaderGeneration: number | null; readonly adoptUnresolved: boolean },
  ): Promise<ProgressSaveResult>;
  /** Settles a Conflict view (only a device store has one), keeping `device` on "Device". */
  resolve(
    choice: "Canonical" | "Device",
    conflict: { readonly canonical: CursorSnapshot; readonly device: Locator },
  ): Promise<ProgressView>;
}

export interface ReaderHost {
  /** Held while positioning programmatically; hosted: the mobile-chrome visible lock. */
  holdChrome?(): () => void;
  /** The surface's scroll element while mounted; hosted: the mobile chrome follows it. */
  scrollport?(element: HTMLElement): (() => void) | undefined;
}
