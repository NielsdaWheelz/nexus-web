import {
  NATIVE_PLAYER_COMMAND_DEADLINE_MS,
  androidPlayerProtocolIdentity,
  decodeAndroidPlayerMessage,
  isAndroidPlayerEvent,
  type AndroidPlayerCommand,
  type AndroidPlayerCommandInput,
  type AndroidPlayerEvent,
  type AndroidPlayerReply,
} from "@/lib/player/androidPlayerProtocol";

interface NexusPlayerBridge {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

declare global {
  // Android injects the bridge on the page's global object.
  var nexusPlayer: NexusPlayerBridge | undefined;
}

type PendingRequest = {
  resolve: (reply: AndroidPlayerReply) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class NativePlayerUnavailableError extends Error {
  constructor(
    message = "Native player is unavailable.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativePlayerUnavailableError";
  }
}

export class NativePlayerTimeoutError extends Error {
  constructor() {
    super("Native player command timed out.");
    this.name = "NativePlayerTimeoutError";
  }
}

/**
 * A command timed out or met a stale session, and the reconciling snapshot
 * did not confirm it. The outcome is unknown, which is a transport condition
 * the user may retry, not malformed data.
 */
export class NativePlayerReconciliationError extends Error {
  constructor(operation: string) {
    super(`${operation} timed out and reconciliation did not confirm it.`);
    this.name = "NativePlayerReconciliationError";
  }
}

export class NativePlayerRejectedError extends Error {
  readonly code: Extract<AndroidPlayerReply, { kind: "Rejected" }>["code"];

  constructor(code: Extract<AndroidPlayerReply, { kind: "Rejected" }>["code"]) {
    super(`Native player rejected the command: ${code}.`);
    this.name = "NativePlayerRejectedError";
    this.code = code;
  }
}

export class AndroidPlayerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: AndroidPlayerEvent) => void>();
  private bridge: NexusPlayerBridge | null = null;
  private readonly onProtocolFailure: (error: unknown) => void;

  constructor(onProtocolFailure: (error: unknown) => void = () => {}) {
    this.onProtocolFailure = onProtocolFailure;
  }

  private readonly onMessage = (event: { data: unknown }): void => {
    // Only ingress classification is a protocol failure; what subscribers do
    // with a valid message is their own outcome.
    let message: AndroidPlayerReply | AndroidPlayerEvent;
    try {
      const raw: unknown =
        typeof event.data === "string"
          ? (JSON.parse(event.data) as unknown)
          : event.data;
      message = decodeAndroidPlayerMessage(raw);
    } catch (error) {
      this.onProtocolFailure(error);
      this.closeWithError(error);
      return;
    }
    if (isAndroidPlayerEvent(message)) {
      for (const listener of this.listeners) listener(message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.kind === "Rejected") {
      pending.reject(new NativePlayerRejectedError(message.code));
    } else {
      pending.resolve(message);
    }
  };

  connectChannel(): void {
    const bridge = globalThis.nexusPlayer;
    if (!bridge || typeof bridge.postMessage !== "function") {
      throw new NativePlayerUnavailableError();
    }
    this.bridge = bridge;
    bridge.onmessage = this.onMessage;
  }

  close(): void {
    this.closeWithError(
      new DOMException("Native player client closed", "AbortError"),
    );
  }

  private closeWithError(error: unknown): void {
    if (this.bridge?.onmessage === this.onMessage) {
      this.bridge.onmessage = null;
    }
    this.bridge = null;
    this.failAll(error);
    this.listeners.clear();
  }

  subscribe(listener: (event: AndroidPlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(
    command: AndroidPlayerCommandInput,
  ): Promise<AndroidPlayerReply> {
    const bridge = this.bridge;
    if (!bridge) {
      return Promise.reject(new NativePlayerUnavailableError());
    }
    const requestId = crypto.randomUUID();
    const wire = {
      ...command,
      requestId,
      ...androidPlayerProtocolIdentity(),
    } satisfies AndroidPlayerCommand;
    const serialized = JSON.stringify(wire);
    return new Promise<AndroidPlayerReply>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new NativePlayerTimeoutError());
      }, NATIVE_PLAYER_COMMAND_DEADLINE_MS);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        bridge.postMessage(serialized);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(
          new NativePlayerUnavailableError(
            "Native player bridge is unavailable.",
            { cause: error },
          ),
        );
      }
    });
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
