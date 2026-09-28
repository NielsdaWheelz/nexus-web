import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { OfflineMediaClientStore } from "./clientStore";
import {
  OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS,
  OFFLINE_MEDIA_PROTOCOL_VERSION,
  decodeOfflineMediaInbound,
  type NetworkPolicy,
  type OfflineDownloadSpec,
  type OfflineMediaCommand,
  type OfflineMediaCommandBody,
  type OfflineMediaRejectedCode,
  type OfflineMediaReplyOutcome,
} from "./contract";
import type { OfflineMediaTransport } from "./transport";

export interface OfflineMediaController {
  readonly enqueue: (mediaId: string) => Promise<void>;
  readonly cancel: (mediaId: string) => Promise<void>;
  readonly retry: (mediaId: string) => Promise<void>;
  readonly remove: (mediaId: string) => Promise<void>;
  readonly setNetworkPolicy: (policy: NetworkPolicy) => Promise<void>;
}

interface PendingReply {
  readonly resolve: (outcome: OfflineMediaReplyOutcome) => void;
  readonly reject: (error: Error) => void;
}

export class OfflineMediaRejectedError extends Error {
  readonly code: OfflineMediaRejectedCode;

  constructor(code: OfflineMediaRejectedCode) {
    super(`Offline media command rejected: ${code}`);
    this.name = "OfflineMediaRejectedError";
    this.code = code;
  }
}

export function offlineMediaRejectionMessage(
  code: OfflineMediaRejectedCode,
): string {
  switch (code) {
    case "NetworkUnavailable":
      return "Connect to the internet and try again.";
    case "SourceMissing":
    case "SourceUnavailable":
      return "This episode’s audio is unavailable.";
    case "SourceForbidden":
    case "UnsupportedAudio":
      return "This episode’s audio can’t be downloaded.";
    case "StorageInsufficient":
      return "Not enough device storage for this download.";
    case "StorageUnavailable":
      return "Device storage is unavailable. Try again.";
    case "AccountMismatch":
      return "Your account changed. Reopen Nexus and try again.";
    case "InvalidRequest":
      return "Couldn’t start this download.";
  }
}

export class OfflineMediaControllerRuntime
  implements OfflineMediaController
{
  private readonly pendingReplies = new Map<string, PendingReply>();
  // At most one resolve per media id. A late spec or reply counts only while
  // its own AbortController is still the map entry.
  private readonly resolving = new Map<string, AbortController>();
  private stopTransport: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly accountId: string,
    private readonly store: OfflineMediaClientStore,
    private readonly transport: OfflineMediaTransport,
    private readonly readDownloadSpec: (
      mediaId: string,
      signal: AbortSignal,
    ) => Promise<OfflineDownloadSpec>,
    private readonly showError: (message: string) => void,
    private readonly onFatal: (error: Error) => void,
    private readonly handleUnauthenticated: (error: unknown) => boolean,
  ) {}

  async connect(): Promise<void> {
    if (this.stopTransport !== null) {
      // justify-defect: one controller owns exactly one transport session.
      throw new Error("Offline media controller connected twice");
    }
    this.stopTransport = this.transport.start((message) => {
      try {
        this.receive(message);
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error("Offline media protocol failed"),
        );
      }
    });
    const outcome = await this.request({
      kind: "Connect",
      accountId: this.accountId,
    });
    if (outcome.kind === "Rejected") {
      throw new OfflineMediaRejectedError(outcome.code);
    }
    if (outcome.kind !== "Connected") {
      // justify-defect: Connect has one successful reply shape.
      throw new Error(`Connect returned ${outcome.kind}`);
    }
    this.store.installSnapshot(outcome.items, outcome.networkPolicy);
  }

  refreshSnapshot = async (): Promise<void> => {
    if (this.disposed) return;
    const outcome = await this.request({ kind: "GetSnapshot" });
    if (outcome.kind === "Rejected") {
      this.showError(offlineMediaRejectionMessage(outcome.code));
      return;
    }
    if (outcome.kind !== "Snapshot") {
      // justify-defect: GetSnapshot has one successful reply shape.
      throw new Error(`GetSnapshot returned ${outcome.kind}`);
    }
    this.store.installSnapshot(outcome.items, outcome.networkPolicy);
  };

  enqueue = async (mediaId: string): Promise<void> => {
    if (
      this.disposed ||
      this.resolving.has(mediaId) ||
      this.store.getInventory().some((item) => item.mediaId === mediaId)
    ) {
      return;
    }
    const request = new AbortController();
    this.resolving.set(mediaId, request);
    const deadline = setTimeout(
      () => request.abort(),
      OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS,
    );
    try {
      const spec = await this.readDownloadSpec(mediaId, request.signal);
      if (this.resolving.get(mediaId) !== request) return;
      if (spec.mediaId !== mediaId) {
        throw new TypeError("OfflineDownloadSpec mediaId mismatch");
      }
      // Resolving must exist before Enqueue is sent: native emits the item's
      // first state before its reply, and an unknown id is a defect.
      this.store.beginResolving(mediaId, spec.title);
      const outcome = await this.request({ kind: "Enqueue", spec });
      if (this.resolving.get(mediaId) !== request) return;
      if (outcome.kind === "Rejected") {
        this.store.clearResolving(mediaId);
        this.showError(offlineMediaRejectionMessage(outcome.code));
        return;
      }
      if (outcome.kind !== "Accepted") {
        // justify-defect: Enqueue has one successful reply shape.
        throw new Error(`Enqueue returned ${outcome.kind}`);
      }
    } catch (error) {
      // justify-ignore-error: a cancelled or disposed resolve owns no outcome;
      // its rejection is our own abort or the ended session.
      if (this.resolving.get(mediaId) !== request) return;
      this.store.clearResolving(mediaId);
      if (this.handleUnauthenticated(error)) return;
      if (isAbortError(error)) {
        // Cancel and dispose end the resolve before aborting it, so a live
        // abort is the deadline.
        this.showError("Preparing the download took too long. Try again.");
        return;
      }
      // justify-defect: only an expected API failure of the spec read is
      // user-facing; decode, protocol and transport violations are defects.
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      this.showError("Couldn’t prepare this download.");
    } finally {
      clearTimeout(deadline);
      if (this.resolving.get(mediaId) === request) {
        this.resolving.delete(mediaId);
      }
    }
  };

  cancel = async (mediaId: string): Promise<void> => {
    const request = this.resolving.get(mediaId);
    this.resolving.delete(mediaId);
    request?.abort();
    // A stale Accepted must keep the Resolving row of a newer resolve.
    if (
      (await this.acceptCommand({ kind: "Cancel", mediaId })) &&
      !this.resolving.has(mediaId)
    ) {
      this.store.clearResolving(mediaId);
    }
  };

  retry = async (mediaId: string): Promise<void> => {
    await this.acceptCommand({ kind: "Retry", mediaId });
  };

  remove = async (mediaId: string): Promise<void> => {
    await this.acceptCommand({ kind: "Remove", mediaId });
  };

  setNetworkPolicy = async (policy: NetworkPolicy): Promise<void> => {
    await this.acceptCommand({ kind: "SetNetworkPolicy", policy });
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTransport?.();
    this.stopTransport = null;
    const requests = [...this.resolving.values()];
    this.resolving.clear();
    for (const request of requests) request.abort();
    const error = new Error("Offline media session ended");
    for (const pending of this.pendingReplies.values()) pending.reject(error);
    this.pendingReplies.clear();
    this.store.clear();
  }

  private async acceptCommand(
    command: OfflineMediaCommandBody,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const outcome = await this.request(command);
    if (outcome.kind === "Rejected") {
      this.showError(offlineMediaRejectionMessage(outcome.code));
      return false;
    }
    if (outcome.kind !== "Accepted") {
      // justify-defect: mutation commands have one successful reply shape.
      throw new Error(`${command.kind} returned ${outcome.kind}`);
    }
    return true;
  }

  private request(
    body: OfflineMediaCommandBody,
  ): Promise<OfflineMediaReplyOutcome> {
    if (this.disposed) {
      return Promise.reject(new Error("Offline media session ended"));
    }
    const command: OfflineMediaCommand = {
      ...body,
      requestId: crypto.randomUUID(),
      protocolVersion: OFFLINE_MEDIA_PROTOCOL_VERSION,
    };
    return new Promise((resolve, reject) => {
      this.pendingReplies.set(command.requestId, { resolve, reject });
      try {
        this.transport.send(command);
      } catch (error) {
        this.pendingReplies.delete(command.requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("Offline media transport failed"),
        );
      }
    });
  }

  private receive(raw: unknown): void {
    if (this.disposed) return;
    const inbound = decodeOfflineMediaInbound(raw);
    if (inbound.kind === "Reply") {
      const pending = this.pendingReplies.get(inbound.reply.requestId);
      if (pending === undefined) {
        // justify-defect: native may reply only to a live correlated command.
        throw new Error(
          `Unexpected offline media reply ${inbound.reply.requestId}`,
        );
      }
      this.pendingReplies.delete(inbound.reply.requestId);
      pending.resolve(inbound.reply.outcome);
      return;
    }
    switch (inbound.event.kind) {
      case "StateChanged":
        this.store.applyNativeState(
          inbound.event.mediaId,
          inbound.event.state,
        );
        break;
      case "NetworkPolicyChanged":
        this.store.installNetworkPolicy(inbound.event.policy);
        break;
    }
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.dispose();
    this.onFatal(error);
  }
}
