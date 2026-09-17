import { apiFetch } from "@/lib/api/client";
import {
  parseReaderCursorSnapshot,
  readerStateConflictCurrent,
  type ReaderCursorSnapshot,
} from "./readerProgress";
import type { ReaderResumeState } from "./types";

export type ReaderProgressView =
  | { readonly kind: "Canonical"; readonly snapshot: ReaderCursorSnapshot }
  | {
      readonly kind: "Pending";
      readonly baseline: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    }
  | {
      readonly kind: "Conflict";
      readonly canonical: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    }
  | {
      readonly kind: "ContentChanged";
      readonly baseline: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    }
  | {
      readonly kind: "SourceUnavailable";
      readonly baseline: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    };

export type ReaderProgressSaveResult =
  | { readonly kind: "Canonical"; readonly snapshot: ReaderCursorSnapshot }
  | { readonly kind: "DurablyPending"; readonly view: ReaderProgressView }
  | {
      readonly kind: "Conflict";
      readonly canonical: ReaderCursorSnapshot;
      readonly device: ReaderResumeState;
    }
  | { readonly kind: "ContentChanged"; readonly view: ReaderProgressView }
  | { readonly kind: "SourceUnavailable"; readonly view: ReaderProgressView };

export interface ReaderProgressPort {
  load(mediaId: string, signal?: AbortSignal): Promise<ReaderProgressView>;
  save(
    mediaId: string,
    locator: ReaderResumeState,
    options?: { readonly keepalive?: boolean; readonly baseRevision?: number },
  ): Promise<ReaderProgressSaveResult>;
  resolve(
    mediaId: string,
    choice: "Canonical" | "Device",
  ): Promise<ReaderProgressView>;
}

class HostedReaderProgressPort implements ReaderProgressPort {
  readonly #baselines = new Map<string, ReaderCursorSnapshot>();
  readonly #conflicts = new Map<
    string,
    { readonly canonical: ReaderCursorSnapshot; readonly device: ReaderResumeState }
  >();

  async load(mediaId: string, signal?: AbortSignal): Promise<ReaderProgressView> {
    const response = await apiFetch<{ data: unknown }>(
      `/api/media/${mediaId}/reader-state`,
      signal ? { signal } : undefined,
    );
    const snapshot = parseReaderCursorSnapshot(response.data);
    this.#baselines.set(mediaId, snapshot);
    return { kind: "Canonical", snapshot };
  }

  async save(
    mediaId: string,
    locator: ReaderResumeState,
    options: { readonly keepalive?: boolean; readonly baseRevision?: number } = {},
  ): Promise<ReaderProgressSaveResult> {
    const baseline = this.#baselines.get(mediaId);
    const baseRevision = options.baseRevision ?? baseline?.revision;
    if (baseRevision === undefined) {
      throw new Error("Reader progress cannot save before loading authority");
    }
    try {
      const response = await apiFetch<{ data: unknown }>(
        `/api/media/${mediaId}/reader-state`,
        {
          method: "PUT",
          body: JSON.stringify({ locator, base_revision: baseRevision }),
          ...(options.keepalive ? { keepalive: true } : {}),
        },
      );
      const snapshot = parseReaderCursorSnapshot(response.data);
      this.#baselines.set(mediaId, snapshot);
      this.#conflicts.delete(mediaId);
      return { kind: "Canonical", snapshot };
    } catch (error) {
      const canonical = readerStateConflictCurrent(error);
      if (canonical === null) throw error;
      this.#baselines.set(mediaId, canonical);
      this.#conflicts.set(mediaId, { canonical, device: locator });
      return { kind: "Conflict", canonical, device: locator };
    }
  }

  async resolve(
    mediaId: string,
    choice: "Canonical" | "Device",
  ): Promise<ReaderProgressView> {
    const conflict = this.#conflicts.get(mediaId);
    if (conflict === undefined) {
      return this.load(mediaId);
    }
    if (choice === "Canonical") {
      this.#conflicts.delete(mediaId);
      this.#baselines.set(mediaId, conflict.canonical);
      return { kind: "Canonical", snapshot: conflict.canonical };
    }
    const result = await this.save(mediaId, conflict.device, {
      baseRevision: conflict.canonical.revision,
    });
    if (result.kind === "Canonical") return result;
    if (result.kind === "Conflict") return result;
    return result.view;
  }
}

export function createHostedReaderProgressPort(): ReaderProgressPort {
  return new HostedReaderProgressPort();
}
