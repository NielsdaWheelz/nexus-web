import { isAbortError } from "@/lib/errors";
import { OfflineMediaClientStore } from "./clientStore";
import {
  OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS,
  OFFLINE_MEDIA_PROTOCOL_VERSION,
  decodeOfflineMediaInbound,
  type NetworkPolicy,
  type OfflineDownloadSpec,
  type OfflineMediaCommand,
  type OfflineMediaRejectedCode,
  type OfflineMediaReplyOutcome,
} from "./contract";
import type { OfflineMediaTransport } from "./transport";

export type OfflineDownloadSpecReader = (
  mediaId: string,
  signal: AbortSignal,
) => Promise<OfflineDownloadSpec>;

export interface OfflineMediaController {
  readonly enqueue: (mediaId: string) => Promise<void>;
  readonly cancel: (mediaId: string) => Promise<void>;
  readonly retry: (mediaId: string) => Promise<void>;
  readonly remove: (mediaId: string) => Promise<void>;
  readonly setNetworkPolicy: (policy: NetworkPolicy) => Promise<void>;
  readonly openDownloads: () => void;
}

interface PendingReply {
  readonly resolve: (outcome: OfflineMediaReplyOutcome) => void;
  readonly reject: (error: Error) => void;
}

interface ResolvingRequest {
  readonly generation: number;
  readonly abortController: AbortController;
  nativeRequested: boolean;
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
  private readonly resolving = new Map<string, ResolvingRequest>();
  private readonly resolvingGenerations = new Map<string, number>();
  private stopTransport: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly accountId: string,
    readonly store: OfflineMediaClientStore,
    private readonly transport: OfflineMediaTransport,
    private readonly readDownloadSpec: OfflineDownloadSpecReader,
    private readonly ownedOrigin: string,
    private readonly showError: (message: string) => void,
    private readonly onFatal: (error: Error) => void,
    private readonly handleUnauthenticated: (error: unknown) => boolean,
    readonly openDownloads: () => void,
    private readonly mintRequestId: () => string = () => crypto.randomUUID(),
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
    if (this.disposed || this.store.getItem(mediaId).kind === "Present") return;
    const generation = (this.resolvingGenerations.get(mediaId) ?? 0) + 1;
    this.resolvingGenerations.set(mediaId, generation);
    const abortController = new AbortController();
    const request = { generation, abortController, nativeRequested: false };
    this.resolving.set(mediaId, request);
    this.store.beginResolving(mediaId);
    let deadlineExpired = false;
    const deadline = setTimeout(() => {
      deadlineExpired = true;
      abortController.abort();
    }, OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS);
    try {
      const spec = await this.readDownloadSpec(mediaId, abortController.signal);
      if (!this.isCurrentResolving(mediaId, request)) return;
      if (spec.mediaId !== mediaId) {
        throw new TypeError("OfflineDownloadSpec mediaId mismatch");
      }
      this.store.updateResolvingTitle(mediaId, spec.title);
      request.nativeRequested = true;
      const outcome = await this.request({ kind: "Enqueue", spec });
      if (!this.isCurrentResolving(mediaId, request)) return;
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
      if (!this.isCurrentResolving(mediaId, request)) return;
      this.store.clearResolving(mediaId);
      if (this.handleUnauthenticated(error)) {
        return;
      }
      if (deadlineExpired) {
        this.showError("Preparing the download took too long. Try again.");
      } else if (!isAbortError(error)) {
        this.showError("Couldn’t prepare this download.");
      }
    } finally {
      clearTimeout(deadline);
      if (this.isCurrentResolving(mediaId, request)) {
        this.resolving.delete(mediaId);
      }
    }
  };

  cancel = async (mediaId: string): Promise<void> => {
    const resolving = this.resolving.get(mediaId);
    if (resolving !== undefined) {
      this.resolvingGenerations.set(mediaId, resolving.generation + 1);
      this.resolving.delete(mediaId);
      resolving.abortController.abort("cancel");
      const current = this.store.getItem(mediaId);
      if (
        !resolving.nativeRequested &&
        (current.kind === "Absent" || current.value.kind === "Resolving")
      ) {
        this.store.clearResolving(mediaId);
        return;
      }
    }
    const accepted = await this.acceptCommand({ kind: "Cancel", mediaId });
    if (resolving !== undefined && accepted) {
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
    for (const request of this.resolving.values()) {
      request.abortController.abort("session-disposed");
    }
    this.resolving.clear();
    const error = new Error("Offline media session ended");
    for (const pending of this.pendingReplies.values()) pending.reject(error);
    this.pendingReplies.clear();
    this.store.clear();
  }

  private async acceptCommand(
    command:
      | { readonly kind: "Cancel" | "Retry" | "Remove"; readonly mediaId: string }
      | { readonly kind: "SetNetworkPolicy"; readonly policy: NetworkPolicy },
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
    command:
      | Omit<Extract<OfflineMediaCommand, { kind: "Connect" }>, "requestId" | "protocolVersion">
      | Omit<Extract<OfflineMediaCommand, { kind: "GetSnapshot" }>, "requestId" | "protocolVersion">
      | Omit<Extract<OfflineMediaCommand, { kind: "Enqueue" }>, "requestId" | "protocolVersion">
      | Omit<Extract<OfflineMediaCommand, { kind: "Cancel" | "Retry" | "Remove" }>, "requestId" | "protocolVersion">
      | Omit<Extract<OfflineMediaCommand, { kind: "SetNetworkPolicy" }>, "requestId" | "protocolVersion">,
  ): Promise<OfflineMediaReplyOutcome> {
    if (this.disposed) {
      return Promise.reject(new Error("Offline media session ended"));
    }
    const requestId = this.mintRequestId();
    let wireCommand: OfflineMediaCommand;
    switch (command.kind) {
      case "Connect":
        wireCommand = {
          kind: command.kind,
          accountId: command.accountId,
          requestId,
          protocolVersion: OFFLINE_MEDIA_PROTOCOL_VERSION,
        };
        break;
      case "GetSnapshot":
        wireCommand = {
          kind: command.kind,
          requestId,
          protocolVersion: OFFLINE_MEDIA_PROTOCOL_VERSION,
        };
        break;
      case "Enqueue":
        wireCommand = {
          kind: command.kind,
          spec: command.spec,
          requestId,
          protocolVersion: OFFLINE_MEDIA_PROTOCOL_VERSION,
        };
        break;
      case "Cancel":
      case "Retry":
      case "Remove":
        wireCommand = {
          kind: command.kind,
          mediaId: command.mediaId,
          requestId,
          protocolVersion: OFFLINE_MEDIA_PROTOCOL_VERSION,
        };
        break;
      case "SetNetworkPolicy":
        wireCommand = {
          kind: command.kind,
          policy: command.policy,
          requestId,
          protocolVersion: OFFLINE_MEDIA_PROTOCOL_VERSION,
        };
        break;
    }
    return new Promise((resolve, reject) => {
      this.pendingReplies.set(requestId, { resolve, reject });
      try {
        this.transport.send(wireCommand);
      } catch (error) {
        this.pendingReplies.delete(requestId);
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

  private isCurrentResolving(
    mediaId: string,
    request: ResolvingRequest,
  ): boolean {
    return (
      !this.disposed &&
      this.resolving.get(mediaId) === request &&
      this.resolvingGenerations.get(mediaId) === request.generation
    );
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.dispose();
    this.onFatal(error);
  }
}
