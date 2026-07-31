import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AndroidPlayerClient,
  NativePlayerRejectedError,
  NativePlayerTimeoutError,
} from "@/lib/player/androidPlayerClient";
import { NATIVE_PLAYER_COMMAND_DEADLINE_MS } from "@/lib/player/androidPlayerProtocol";

const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_REQUEST = "33333333-3333-4333-8333-333333333333";

interface TestBridge {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: { data: unknown }) => void) | null;
}

function installBridge(): TestBridge {
  const bridge: TestBridge = {
    postMessage: vi.fn(),
    onmessage: null,
  };
  vi.stubGlobal("window", { nexusPlayer: bridge });
  return bridge;
}

function postedCommand(
  bridge: TestBridge,
  index = 0,
): Record<string, unknown> {
  return JSON.parse(
    bridge.postMessage.mock.calls[index]![0] as string,
  ) as Record<string, unknown>;
}

function deliver(
  bridge: TestBridge,
  message: Record<string, unknown> | string,
): void {
  bridge.onmessage?.({
    data: typeof message === "string" ? message : JSON.stringify(message),
  });
}

describe("AndroidPlayerClient", () => {
  let client: AndroidPlayerClient | null;

  beforeEach(() => {
    client = null;
    vi.useRealTimers();
  });

  afterEach(() => {
    client?.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts the device default command without a session key", async () => {
    const bridge = installBridge();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_A);
    client = new AndroidPlayerClient();
    client.connectChannel();

    const pending = client.request({
      kind: "SetDeviceDefaultPauseShorteningMode",
      mode: "Natural",
    });

    expect(postedCommand(bridge)).toEqual({
      kind: "SetDeviceDefaultPauseShorteningMode",
      mode: "Natural",
      requestId: REQUEST_A,
      protocolVersion: 1,
    });
    expect(postedCommand(bridge)).not.toHaveProperty("sessionKey");

    deliver(bridge, {
      kind: "Accepted",
      requestId: REQUEST_A,
      protocolVersion: 1,
    });
    await expect(pending).resolves.toEqual({
      kind: "Accepted",
      requestId: REQUEST_A,
      protocolVersion: 1,
    });
  });

  it("correlates replies and ignores a reply for an unknown request", async () => {
    const bridge = installBridge();
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValueOnce(REQUEST_B);
    client = new AndroidPlayerClient();
    client.connectChannel();

    let firstSettled = false;
    const first = client.request({ kind: "GetSnapshot" });
    void first.then(() => {
      firstSettled = true;
    });
    const second = client.request({ kind: "GetSnapshot" });

    deliver(bridge, {
      kind: "Accepted",
      requestId: UNKNOWN_REQUEST,
      protocolVersion: 1,
    });
    deliver(bridge, {
      kind: "Accepted",
      requestId: REQUEST_B,
      protocolVersion: 1,
    });

    await expect(second).resolves.toMatchObject({
      kind: "Accepted",
      requestId: REQUEST_B,
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    deliver(bridge, {
      kind: "Accepted",
      requestId: REQUEST_A,
      protocolVersion: 1,
    });
    await expect(first).resolves.toMatchObject({
      kind: "Accepted",
      requestId: REQUEST_A,
    });
  });

  it("delivers an exact controller-reconnection event to subscribers", () => {
    const bridge = installBridge();
    client = new AndroidPlayerClient();
    client.connectChannel();
    const listener = vi.fn();
    client.subscribe(listener);
    const event = {
      kind: "ControllerReconnected",
      protocolVersion: 1,
      snapshot: {
        kind: "Absent",
        deviceDefaultPauseShorteningMode: "Off",
        pauseShorteningSavedOnDeviceMs: 42,
      },
      pendingNaturalEnd: { kind: "Absent" },
    };

    deliver(bridge, event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("rejects only the correlated request when native rejects it", async () => {
    const bridge = installBridge();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_A);
    client = new AndroidPlayerClient();
    client.connectChannel();

    const pending = client.request({ kind: "GetSnapshot" });
    deliver(bridge, {
      kind: "Rejected",
      requestId: REQUEST_A,
      protocolVersion: 1,
      code: "StaleSession",
    });

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<NativePlayerRejectedError>>({
        name: "NativePlayerRejectedError",
        code: "StaleSession",
      }),
    );
  });

  it("times out a request at the native command deadline", async () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(REQUEST_A);
    client = new AndroidPlayerClient();
    client.connectChannel();

    const pending = client.request({ kind: "GetSnapshot" });
    const rejection = expect(pending).rejects.toBeInstanceOf(
      NativePlayerTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(
      NATIVE_PLAYER_COMMAND_DEADLINE_MS - 1,
    );
    expect(bridge.postMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it("fails all pending requests when the bridge sends malformed JSON", async () => {
    const bridge = installBridge();
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValueOnce(REQUEST_B);
    client = new AndroidPlayerClient();
    client.connectChannel();

    const first = client.request({ kind: "GetSnapshot" });
    const second = client.request({ kind: "GetSnapshot" });
    const firstRejection = expect(first).rejects.toBeInstanceOf(SyntaxError);
    const secondRejection = expect(second).rejects.toBeInstanceOf(SyntaxError);

    deliver(bridge, '{"kind":');

    await Promise.all([firstRejection, secondRejection]);
  });

  it("fails all pending requests when a bridge message violates the exact protocol", async () => {
    const bridge = installBridge();
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValueOnce(REQUEST_B);
    client = new AndroidPlayerClient();
    client.connectChannel();

    const first = client.request({ kind: "GetSnapshot" });
    const second = client.request({ kind: "GetSnapshot" });
    const firstRejection = expect(first).rejects.toBeInstanceOf(TypeError);
    const secondRejection = expect(second).rejects.toBeInstanceOf(TypeError);

    deliver(bridge, {
      kind: "Accepted",
      requestId: REQUEST_A,
      protocolVersion: 1,
      extra: "drift",
    });

    await Promise.all([firstRejection, secondRejection]);
  });
});
