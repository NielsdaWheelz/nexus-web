import {
  ApiError,
  apiErrorFromResponse,
  fetchApiResponse,
  type ApiPath,
} from "@/lib/api/client";
import { readBoundedResponseBytes } from "@/lib/api/readBoundedResponseBytes";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import type { MediaImageProxySrc } from "./imageProxy";

// Existing source contract. Derivative residency requires a separately measured profile.
const MAX_ENCODED_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_DIMENSION = 4096;

type ArtworkState =
  | { readonly kind: "Loading" }
  | {
      readonly kind: "Ready";
      readonly url: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "Failed"; readonly error: unknown };

export interface ArtworkLease {
  readonly read: () => ArtworkState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly retry: () => void;
  readonly release: () => void;
}

interface Entry {
  readonly key: string;
  readonly source: MediaImageProxySrc;
  readonly width: number;
  readonly height: number;
  readonly listeners: Set<() => void>;
  consumers: number;
  state: ArtworkState;
  controller: AbortController | null;
  reserved: boolean;
  passedOver: boolean;
}

interface ArtworkSource {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

type ArtworkFailure = Extract<ArtworkState, { kind: "Failed" }>;

/** Visible artwork owns display-sized first frames; the final consumer releases them. */
export class ArtworkReader {
  private readonly entries = new Map<string, Entry>();
  private readonly failureListeners = new Set<
    (failure: ArtworkFailure | null) => void
  >();
  private residentPixels = 0;
  private sourceReads = 0;
  private decodes: Promise<void> = Promise.resolve();
  private readonly maxSourceReads: number;

  constructor(
    private readonly limits: {
      readonly maxDimension: number;
      readonly residentPixels: number;
    },
  ) {
    if (
      !Number.isSafeInteger(limits.maxDimension) ||
      limits.maxDimension < 1 ||
      !Number.isSafeInteger(limits.residentPixels) ||
      limits.residentPixels < limits.maxDimension ** 2
    ) {
      throw new Error(
        "Artwork requires a qualified display and residency profile",
      );
    }
    // Source reads overlap only as far as the profile's full-size derivative
    // slots. Transfers hold no decoded pixels, so one stalled origin must not
    // occupy the producer that every other visible cover waits behind.
    this.maxSourceReads = Math.floor(
      limits.residentPixels / limits.maxDimension ** 2,
    );
  }

  readonly subscribeFailures = (
    listener: (failure: ArtworkFailure | null) => void,
  ): (() => void) => {
    this.failureListeners.add(listener);
    for (const entry of this.entries.values())
      if (entry.state.kind === "Failed") listener(entry.state);
    return () => this.failureListeners.delete(listener);
  };

  get maxDimension(): number {
    return this.limits.maxDimension;
  }

  readonly failedDemands = (): number => {
    let count = 0;
    for (const entry of this.entries.values())
      if (entry.state.kind === "Failed") count += 1;
    return count;
  };

  readonly retryFailures = (): void => {
    for (const entry of this.entries.values()) {
      if (entry.state.kind !== "Failed") continue;
      entry.state = { kind: "Loading" };
      for (const listener of entry.listeners) listener();
    }
    for (const listener of this.failureListeners) listener(null);
    this.drain();
  };

  acquire(
    source: MediaImageProxySrc,
    requestedWidth: number,
    requestedHeight: number,
  ): ArtworkLease {
    if (
      ![requestedWidth, requestedHeight].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    ) {
      throw new Error("Artwork demand requires positive display dimensions");
    }
    const scale = Math.min(
      1,
      this.limits.maxDimension / Math.max(requestedWidth, requestedHeight),
    );
    const width = Math.max(1, Math.round(requestedWidth * scale));
    const height = Math.max(1, Math.round(requestedHeight * scale));
    const key = JSON.stringify([source, width, height]);
    // A mapped entry always has a live consumer: the last release deletes it.
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        source,
        width,
        height,
        listeners: new Set(),
        consumers: 0,
        state: { kind: "Loading" },
        controller: null,
        reserved: false,
        passedOver: false,
      };
      this.entries.set(key, entry);
    }
    const owned = entry;
    owned.consumers += 1;
    let released = false;
    this.drain();
    return {
      read: () => owned.state,
      subscribe: (listener) => {
        owned.listeners.add(listener);
        return () => owned.listeners.delete(listener);
      },
      retry: () => {
        if (released || owned.state.kind !== "Failed") return;
        owned.state = { kind: "Loading" };
        for (const listener of owned.listeners) listener();
        for (const listener of this.failureListeners) listener(null);
        this.drain();
      },
      release: () => {
        if (released) return;
        released = true;
        owned.consumers -= 1;
        if (owned.consumers > 0) return;
        this.entries.delete(key);
        if (owned.state.kind === "Failed")
          for (const listener of this.failureListeners) listener(null);
        owned.controller?.abort();
        if (owned.state.kind === "Ready") {
          URL.revokeObjectURL(owned.state.url);
          this.releaseReservation(owned);
        }
        this.drain();
      },
    };
  }

  private releaseReservation(entry: Entry): void {
    if (!entry.reserved) return;
    entry.reserved = false;
    this.residentPixels -= entry.width * entry.height;
  }

  /**
   * Demand is served first-fit within the residency budget, in arrival order.
   * A waiting demand that does not fit is passed over once and then admits
   * before any later arrival, so the largest cover cannot be starved by a
   * churning list of small ones.
   */
  private nextAdmission(): Entry | undefined {
    const waiting = [...this.entries.values()].filter(
      (candidate) =>
        candidate.state.kind === "Loading" && candidate.controller === null,
    );
    const free = this.limits.residentPixels - this.residentPixels;
    const fits = (candidate: Entry) =>
      candidate.width * candidate.height <= free;
    const passedOver = waiting.find((candidate) => candidate.passedOver);
    if (passedOver) return fits(passedOver) ? passedOver : undefined;
    const admitted = waiting.find(fits);
    if (!admitted) return undefined;
    for (const candidate of waiting) {
      if (candidate === admitted) break;
      candidate.passedOver = true;
    }
    return admitted;
  }

  private drain(): void {
    while (this.sourceReads < this.maxSourceReads) {
      const entry = this.nextAdmission();
      if (!entry) return;
      entry.controller = new AbortController();
      entry.reserved = true;
      entry.passedOver = false;
      this.residentPixels += entry.width * entry.height;
      this.sourceReads += 1;
      void this.load(entry, entry.controller.signal).finally(() => {
        entry.controller = null;
        if (entry.state.kind !== "Ready") this.releaseReservation(entry);
        this.drain();
      });
    }
  }

  private async load(entry: Entry, signal: AbortSignal): Promise<void> {
    try {
      const source = await this.read(entry, signal);
      const decode = this.decodes.then(() => this.render(entry, source, signal));
      this.decodes = decode.catch(() => undefined);
      await decode;
    } catch (error) {
      if (!signal.aborted) {
        entry.state = { kind: "Failed", error };
        for (const listener of this.failureListeners) listener(entry.state);
      }
    }
    if (entry.consumers > 0) for (const listener of entry.listeners) listener();
  }

  /** The read slot ends with its transfer, never with the decode behind it. */
  private async read(
    entry: Entry,
    signal: AbortSignal,
  ): Promise<ArtworkSource> {
    try {
      return await requestWithRetry(async (attemptSignal) => {
        // justify-type-assertion: MediaImageProxySrc is validated at its sole owned /api/media/image builder/parser.
        const response = await fetchApiResponse(entry.source as ApiPath, {
          signal: attemptSignal,
        });
        if (!response.ok) throw await apiErrorFromResponse(response);
        const widthText = response.headers.get("x-nexus-image-width");
        const heightText = response.headers.get("x-nexus-image-height");
        const width =
          widthText !== null && /^[1-9][0-9]*$/.test(widthText)
            ? Number(widthText)
            : NaN;
        const height =
          heightText !== null && /^[1-9][0-9]*$/.test(heightText)
            ? Number(heightText)
            : NaN;
        const type = response.headers.get("content-type")?.split(";", 1)[0];
        if (
          response.status !== 200 ||
          !type?.startsWith("image/") ||
          type === "image/svg+xml" ||
          ![width, height].every(
            (value) =>
              Number.isSafeInteger(value) && value <= MAX_SOURCE_DIMENSION,
          )
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new ApiError(
            response.status,
            "E_INVALID_RESPONSE",
            "Artwork violates its validated display contract",
          );
        }
        const bytes = await readBoundedResponseBytes(
          response,
          attemptSignal,
          MAX_ENCODED_BYTES,
        );
        return { blob: new Blob([bytes], { type }), width, height };
      }, signal);
    } finally {
      this.sourceReads -= 1;
      this.drain();
    }
  }

  /** One producer at a time turns owned source bytes into the derivative. */
  private async render(
    entry: Entry,
    source: ArtworkSource,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const scale = Math.min(
      1,
      entry.width / source.width,
      entry.height / source.height,
    );
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const bitmap = await createImageBitmap(source.blob, {
      imageOrientation: "from-image",
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "high",
    });
    const canvas = document.createElement("canvas");
    try {
      signal.throwIfAborted();
      if (bitmap.width !== width || bitmap.height !== height)
        throw new Error("Artwork decoder ignored its display bound");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Artwork canvas is unavailable");
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("Artwork derivative could not be encoded"));
        }, "image/png"),
      );
      signal.throwIfAborted();
      entry.state = {
        kind: "Ready",
        url: URL.createObjectURL(blob),
        width,
        height,
      };
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
