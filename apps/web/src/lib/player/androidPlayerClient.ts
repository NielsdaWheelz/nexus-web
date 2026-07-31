import {
  ANDROID_PLAYER_PROTOCOL_VERSION,
  NATIVE_PLAYER_COMMAND_DEADLINE_MS,
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
  interface Window {
    nexusPlayer?: NexusPlayerBridge;
  }
}

type PendingRequest = {
  resolve: (reply: AndroidPlayerReply) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class NativePlayerUnavailableError extends Error {
  constructor(message = "Native player is unavailable.") {
    super(message);
    this.name = "NativePlayerUnavailableError";
  }
}

export class NativePlayerTimeoutError extends Error {
  constructor() {
    super("Native player command timed out.");
    this.name = "NativePlayerTimeoutError";
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
    let raw: unknown;
    try {
      raw =
        typeof event.data === "string"
          ? (JSON.parse(event.data) as unknown)
          : event.data;
      const message = decodeAndroidPlayerMessage(raw);
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
    } catch (error) {
      this.onProtocolFailure(error);
      this.closeWithError(error);
    }
  };

  connectChannel(): void {
    const bridge = window.nexusPlayer;
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
      protocolVersion: ANDROID_PLAYER_PROTOCOL_VERSION,
    } as AndroidPlayerCommand;
    return new Promise<AndroidPlayerReply>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new NativePlayerTimeoutError());
      }, NATIVE_PLAYER_COMMAND_DEADLINE_MS);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        bridge.postMessage(JSON.stringify(wire));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
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
