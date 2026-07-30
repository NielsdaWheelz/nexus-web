import { describe, expect, it, vi } from "vitest";
import { createWebKitOfflineMediaTransport } from "./transport";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

describe("WebKit offline media transport", () => {
  it("is absent unless the exact native object was injected", () => {
    expect(createWebKitOfflineMediaTransport({})).toBeNull();
  });

  it("serializes commands and parses messages through the injected port", () => {
    const port = {
      postMessage: vi.fn(),
      onmessage: null as ((event: { data: unknown }) => void) | null,
    };
    const transport = createWebKitOfflineMediaTransport({
      nexusOfflineMedia: port,
    });
    if (transport === null) throw new Error("Expected native transport");
    const listener = vi.fn();
    const stop = transport.start(listener);

    transport.send({
      kind: "GetSnapshot",
      requestId: REQUEST_ID,
      protocolVersion: 1,
    });
    port.onmessage?.({
      data: JSON.stringify({
        requestId: REQUEST_ID,
        protocolVersion: 1,
        outcome: { kind: "Accepted" },
      }),
    });

    expect(port.postMessage).toHaveBeenCalledWith(
      JSON.stringify({
        kind: "GetSnapshot",
        requestId: REQUEST_ID,
        protocolVersion: 1,
      }),
    );
    expect(listener).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      protocolVersion: 1,
      outcome: { kind: "Accepted" },
    });

    stop();
    expect(port.onmessage).toBeNull();
  });

  it("forwards malformed and non-string messages for strict contract rejection", () => {
    const port = {
      postMessage: vi.fn(),
      onmessage: null as ((event: { data: unknown }) => void) | null,
    };
    const transport = createWebKitOfflineMediaTransport({
      nexusOfflineMedia: port,
    });
    if (transport === null) throw new Error("Expected native transport");
    const listener = vi.fn();
    transport.start(listener);

    port.onmessage?.({ data: "{" });
    port.onmessage?.({ data: { unexpected: true } });

    expect(listener).toHaveBeenNthCalledWith(1, "{");
    expect(listener).toHaveBeenNthCalledWith(2, { unexpected: true });
  });
});
