import {
  OFFLINE_READING_PROTOCOL_VERSION,
  decodeReadingInbound,
  type NetworkPolicy,
  type ReadingCommand,
  type ReadingReplyOutcome,
  type ReadingSnapshot,
} from "./contract";
import type { ReaderResumeState } from "@/lib/reader/types";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
export type { OfflineReadingTransport } from "./transport";
import type { OfflineReadingTransport } from "./transport";

type ReadingRequest = {
  [Command in ReadingCommand as Command["kind"]]: Omit<
    Command,
    "protocolVersion" | "requestId"
  >;
}[ReadingCommand["kind"]];

interface PendingReply {
  readonly resolve: (outcome: ReadingReplyOutcome) => void;
  readonly reject: (error: Error) => void;
}

export interface OpenedOfflineReading {
  readonly leaseId: string;
  readonly readerGeneration: number;
  readonly readerRevisionKey: string;
  readonly readerUrl: string;
  readonly progress: ReaderProgressView;
  readonly installedAt: string;
}

export class OfflineReadingRejectedError extends Error {
  constructor(
    readonly code: Extract<ReadingReplyOutcome, { kind: "Rejected" }>["code"],
  ) {
    super(`Offline reading command rejected: ${code}`);
    this.name = "OfflineReadingRejectedError";
  }
}

/**
 * The native snapshot declared a bound account other than the one this
 * renderer is authenticated as. The renderer never projects a foreign
 * binding's inventory (TB-15); the session is dropped instead.
 */
export class OfflineReadingForeignBindingError extends Error {
  constructor(
    readonly expectedAccountId: string,
    readonly boundAccountId: string,
  ) {
    super("Offline reading snapshot is bound to another account");
    this.name = "OfflineReadingForeignBindingError";
  }
}

export interface OfflineReadingControllerOptions {
  /**
   * The hosted account this session may project. When present, a snapshot
   * bound to any other account is refused instead of rendered.
   */
  readonly expectedAccountId?: string;
  readonly mintRequestId?: () => string;
}

export class OfflineReadingControllerRuntime {
  readonly #pending = new Map<string, PendingReply>();
  readonly #listeners = new Set<() => void>();
  readonly #openRequestListeners = new Set<(mediaId: string) => void>();
  readonly #defectListeners = new Set<(error: Error) => void>();
  readonly #expectedAccountId: string | null;
  readonly #mintRequestId: () => string;
  #snapshot: ReadingSnapshot | null = null;
  #defect: Error | null = null;
  #stop: (() => void) | null = null;
  #disposed = false;
  #pendingOpenRequest: string | null = null;

  constructor(
    readonly transport: OfflineReadingTransport,
    options: OfflineReadingControllerOptions = {},
  ) {
    this.#expectedAccountId = options.expectedAccountId ?? null;
    this.#mintRequestId = options.mintRequestId ?? (() => crypto.randomUUID());
  }

  readonly getSnapshot = (): ReadingSnapshot | null => this.#snapshot;

  readonly getDefect = (): Error | null => this.#defect;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly subscribeOpenRequest = (
    listener: (mediaId: string) => void,
  ): (() => void) => {
    this.#openRequestListeners.add(listener);
    if (this.#pendingOpenRequest !== null) {
      const mediaId = this.#pendingOpenRequest;
      this.#pendingOpenRequest = null;
      listener(mediaId);
    }
    return () => this.#openRequestListeners.delete(listener);
  };

  /** Session-fatal transport/protocol failures observed outside a request. */
  readonly subscribeDefect = (
    listener: (error: Error) => void,
  ): (() => void) => {
    this.#defectListeners.add(listener);
    return () => this.#defectListeners.delete(listener);
  };

  async connect(mode: "Hosted" | "Offline"): Promise<ReadingSnapshot> {
    if (this.#stop !== null)
      throw new Error("Offline reading controller connected twice");
    try {
      this.#stop = this.transport.start(
        (raw) => this.#receive(raw),
        (error) => this.#fail(error),
      );
      const outcome = await this.#request({
        kind: mode === "Hosted" ? "ConnectHosted" : "ConnectOffline",
      });
      if (outcome.kind === "Rejected")
        throw new OfflineReadingRejectedError(outcome.code);
      if (outcome.kind !== "Connected")
        throw new Error(`Connect returned ${outcome.kind}`);
      return this.#installSnapshot(outcome.snapshot);
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new Error("Offline reading connection failed");
      this.#fail(failure);
      throw failure;
    }
  }

  async refresh(): Promise<ReadingSnapshot> {
    const outcome = await this.#request({ kind: "GetSnapshot" });
    if (outcome.kind === "Rejected")
      throw new OfflineReadingRejectedError(outcome.code);
    if (outcome.kind !== "Snapshot")
      throw new Error(`GetSnapshot returned ${outcome.kind}`);
    return this.#installSnapshot(outcome.snapshot);
  }

  enqueue(
    input: Omit<Extract<ReadingRequest, { kind: "Enqueue" }>, "kind">,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(input.readerGeneration) ||
      input.readerGeneration < 1
    ) {
      throw new Error("Offline download requires a selected reader generation");
    }
    return this.#accept({ kind: "Enqueue", ...input });
  }

  cancel(mediaId: string): Promise<void> {
    return this.#accept({ kind: "Cancel", mediaId });
  }

  retry(mediaId: string): Promise<void> {
    return this.#accept({ kind: "Retry", mediaId });
  }

  remove(mediaId: string): Promise<void> {
    return this.#accept({ kind: "Remove", mediaId })
      .then(() => this.refresh())
      .then(() => undefined);
  }

  setNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    return this.#accept({ kind: "SetNetworkPolicy", policy });
  }

  logoutAndPurge(): Promise<void> {
    return this.#accept({ kind: "LogoutAndPurge" });
  }

  openHosted(): Promise<void> {
    return this.#accept({ kind: "OpenHosted" });
  }

  async open(mediaId: string): Promise<OpenedOfflineReading> {
    const outcome = await this.#request({ kind: "OpenReading", mediaId });
    if (outcome.kind === "Rejected")
      throw new OfflineReadingRejectedError(outcome.code);
    if (outcome.kind !== "OpenedReading")
      throw new Error(`OpenReading returned ${outcome.kind}`);
    return outcome;
  }

  openDownloadedCopy(mediaId: string): Promise<void> {
    return this.#accept({ kind: "OpenDownloadedCopy", mediaId });
  }

  close(leaseId: string): Promise<void> {
    return this.#accept({ kind: "CloseReading", leaseId });
  }

  async saveReaderProgress({
    mediaId,
    readerGeneration,
    readerRevisionKey,
    locator,
  }: {
    readonly mediaId: string;
    readonly readerGeneration: number;
    readonly readerRevisionKey: string;
    readonly locator: ReaderResumeState;
  }) {
    const outcome = await this.#request({
      kind: "SaveReaderProgress",
      mediaId,
      readerGeneration,
      readerRevisionKey,
      locator,
    });
    if (outcome.kind === "Rejected")
      throw new OfflineReadingRejectedError(outcome.code);
    if (outcome.kind !== "ReaderProgressSaved") {
      throw new Error(`SaveReaderProgress returned ${outcome.kind}`);
    }
    return outcome.result;
  }

  async resolveReaderProgress(
    input: Omit<
      Extract<ReadingRequest, { kind: "ResolveReaderProgress" }>,
      "kind"
    >,
  ) {
    const outcome = await this.#request({
      kind: "ResolveReaderProgress",
      ...input,
    });
    if (outcome.kind === "Rejected")
      throw new OfflineReadingRejectedError(outcome.code);
    if (outcome.kind !== "ReaderProgressSaved") {
      throw new Error(`ResolveReaderProgress returned ${outcome.kind}`);
    }
    const result = outcome.result;
    return result.kind === "Canonical"
      ? { kind: "Canonical" as const, snapshot: result.snapshot }
      : result.kind === "Conflict"
        ? result
        : result.view;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stop?.();
    this.#stop = null;
    const error = new Error("Offline reading session ended");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#pendingOpenRequest = null;
    this.#snapshot = null;
    this.#emit();
  }

  async #accept(command: ReadingRequest): Promise<void> {
    const outcome = await this.#request(command);
    if (outcome.kind === "Rejected")
      throw new OfflineReadingRejectedError(outcome.code);
    if (outcome.kind !== "Accepted")
      throw new Error(`${command.kind} returned ${outcome.kind}`);
  }

  #request(command: ReadingRequest): Promise<ReadingReplyOutcome> {
    if (this.#disposed)
      return Promise.reject(new Error("Offline reading session ended"));
    if (this.#defect !== null) return Promise.reject(this.#defect);
    const requestId = this.#mintRequestId();
    const wire = {
      ...command,
      requestId,
      protocolVersion: OFFLINE_READING_PROTOCOL_VERSION,
    } as ReadingCommand;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.transport.send(wire);
      } catch (error) {
        this.#pending.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("Offline reading transport failed"),
        );
      }
    });
  }

  #receive(raw: unknown): void {
    if (this.#disposed || this.#defect !== null) return;
    let message: ReturnType<typeof decodeReadingInbound>;
    try {
      message = decodeReadingInbound(raw);
    } catch (error) {
      // An undecodable inbound frame is a same-system protocol defect. It must
      // become visible state, never an exception thrown out of the port
      // callback that leaves every pending request unsettled.
      this.#fail(
        error instanceof Error
          ? error
          : new Error("Offline reading reply could not be decoded"),
      );
      return;
    }
    if (message.kind === "OpenReadingRequested") {
      if (this.#openRequestListeners.size === 0)
        this.#pendingOpenRequest = message.mediaId;
      for (const listener of this.#openRequestListeners)
        listener(message.mediaId);
      return;
    }
    if (message.kind === "SnapshotChanged") {
      // A refused binding has already been recorded as the session defect by
      // #installSnapshot; the push has nowhere else to report.
      try {
        this.#installSnapshot(message.snapshot);
      } catch {
        return;
      }
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) {
      this.#fail(
        new Error(`Unexpected offline reading reply ${message.requestId}`),
      );
      return;
    }
    this.#pending.delete(message.requestId);
    pending.resolve(message.outcome);
  }

  #installSnapshot(snapshot: ReadingSnapshot): ReadingSnapshot {
    const boundAccountId =
      snapshot.binding.kind === "Present"
        ? snapshot.binding.value.accountId
        : null;
    if (
      this.#expectedAccountId !== null &&
      boundAccountId !== null &&
      boundAccountId !== this.#expectedAccountId
    ) {
      const defect = new OfflineReadingForeignBindingError(
        this.#expectedAccountId,
        boundAccountId,
      );
      this.#fail(defect);
      throw defect;
    }
    this.#snapshot = snapshot;
    this.#emit();
    return snapshot;
  }

  /** Ends the session with a visible reason and settles every pending request. */
  #fail(error: Error): void {
    if (this.#disposed || this.#defect !== null) return;
    this.#defect = error;
    this.#pendingOpenRequest = null;
    this.#snapshot = null;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#emit();
    for (const listener of this.#defectListeners) listener(error);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
