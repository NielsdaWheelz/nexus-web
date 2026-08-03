import { afterEach, describe, expect, it, vi } from "vitest";
import {
  proxyExtensionToFastAPI,
  proxyToFastAPIWithDeps,
} from "./proxy";

const REQUEST_ID = "proxy-unit-request";
const ACCESS_TOKEN = "proxy-unit-access-token";

interface ControlledBody {
  readonly response: Response;
  close(): void;
}

function controlledResponse(
  chunks: readonly Uint8Array[],
  headers: HeadersInit,
): ControlledBody {
  let closeBody: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      closeBody = () => controller.close();
    },
  });
  return {
    response: new Response(stream, { headers }),
    close() {
      if (closeBody === null) {
        throw new Error("controlled response body was not initialized");
      }
      closeBody();
    },
  };
}

function authenticatedDeps(
  externalFetch: typeof fetch,
): Parameters<typeof proxyToFastAPIWithDeps>[2] {
  return {
    readSession: () => ({
      state: "active",
      accessToken: ACCESS_TOKEN,
      expiresAt: 4_102_444_800,
      cookieNames: [],
    }),
    fetch: externalFetch,
    generateRequestId: () => REQUEST_ID,
    appPublicOrigin: "http://localhost:3000",
    config: {
      fastApiBaseUrl: "http://localhost:8000",
      internalSecret: "proxy-unit-internal-secret",
    },
  };
}

function expectSensitiveHeadersRemoved(response: Response): void {
  expect(
    response.headers.get("authorization"),
    "proxied response disclosed upstream authorization",
  ).toBeNull();
  expect(
    response.headers.get("set-cookie"),
    "proxied response disclosed an upstream cookie",
  ).toBeNull();
  expect(
    response.headers.get("x-nexus-internal"),
    "proxied response disclosed the BFF trust secret",
  ).toBeNull();
  expect(
    response.headers.get("x-internal-storage-url"),
    "proxied response disclosed an internal storage location",
  ).toBeNull();
}

describe("BFF response streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an authenticated response without consuming its exact upstream body", async () => {
    const encoder = new TextEncoder();
    const first = encoder.encode('{"data":');
    const second = encoder.encode("[]}");
    const byteLength = first.byteLength + second.byteLength;
    const upstream = controlledResponse([first, second], {
      authorization: "Bearer upstream-secret",
      "content-length": String(byteLength),
      "content-type": "application/json",
      "server-timing": "nexus_api;dur=12.34, nexus_auth;dur=1.25",
      "set-cookie": "upstream-session=secret",
      "x-internal-storage-url": "http://storage.internal/private",
      "x-nexus-internal": "upstream-trust-secret",
      "x-request-id": "fastapi-request",
    });
    let forwardedAuthorization: string | null = null;
    const externalFetch: typeof fetch = async (_input, init) => {
      forwardedAuthorization = new Headers(init?.headers).get("authorization");
      return upstream.response;
    };
    upstream.close();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/resource-items/openables/search"),
      "/resource-items/openables/search",
      authenticatedDeps(externalFetch),
    );

    expect(
      upstream.response.bodyUsed,
      "authenticated proxy consumed the upstream body before returning",
    ).toBe(false);
    expect(forwardedAuthorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(
      response.headers.get("content-length"),
      "structured API responses must not forward the upstream hop-specific length",
    ).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("fastapi-request");
    expect(response.headers.get("server-timing")).toMatch(
      /^nexus_api;dur=12\.34, nexus_auth;dur=1\.25, nexus_bff;dur=\d+\.\d{2}$/,
    );
    expectSensitiveHeadersRemoved(response);

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([...first, ...second]),
    );
  });

  it("returns an extension response without consuming or disclosing its upstream body", async () => {
    const encoder = new TextEncoder();
    const first = encoder.encode("extension-");
    const second = encoder.encode("payload");
    const upstream = controlledResponse([first, second], {
      authorization: "Bearer upstream-secret",
      "content-type": "application/octet-stream",
      "set-cookie": "upstream-session=secret",
      "x-internal-storage-url": "http://storage.internal/private",
      "x-nexus-internal": "upstream-trust-secret",
      "x-request-id": "extension-fastapi-request",
    });
    let forwardedAuthorization: string | null = null;
    const externalFetch: typeof fetch = async (_input, init) => {
      forwardedAuthorization = new Headers(init?.headers).get("authorization");
      return upstream.response;
    };
    vi.stubGlobal("fetch", externalFetch);
    upstream.close();

    const response = await proxyExtensionToFastAPI(
      new Request("http://localhost:3000/api/extension/capture", {
        headers: { authorization: "Bearer extension-token" },
      }),
      "/media/capture/article",
    );

    expect(
      upstream.response.bodyUsed,
      "extension proxy consumed the upstream body before returning",
    ).toBe(false);
    expect(forwardedAuthorization).toBe("Bearer extension-token");
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("x-request-id")).toBe(
      "extension-fastapi-request",
    );
    expectSensitiveHeadersRemoved(response);

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([...first, ...second]),
    );
  });

  it("keeps HEAD and protocol null-body statuses bodyless in both proxy owners", async () => {
    const cases = [
      { method: "HEAD", status: 200 },
      { method: "GET", status: 204 },
      { method: "GET", status: 205 },
      { method: "GET", status: 304 },
    ] as const;

    for (const testCase of cases) {
      const authenticatedFetch: typeof fetch = async () =>
        new Response(testCase.method === "HEAD" ? "ignored" : null, {
          status: testCase.status,
        });
      const authenticated = await proxyToFastAPIWithDeps(
        new Request("http://localhost:3000/api/bodyless", {
          method: testCase.method,
        }),
        "/bodyless",
        authenticatedDeps(authenticatedFetch),
      );
      expect(
        authenticated.body,
        `authenticated ${testCase.method} ${testCase.status} acquired a response body`,
      ).toBeNull();

      const extensionFetch: typeof fetch = async () =>
        new Response(testCase.method === "HEAD" ? "ignored" : null, {
          status: testCase.status,
        });
      vi.stubGlobal("fetch", extensionFetch);
      const extension = await proxyExtensionToFastAPI(
        new Request("http://localhost:3000/api/extension/bodyless", {
          method: testCase.method,
          headers: { authorization: "Bearer extension-token" },
        }),
        "/bodyless",
      );
      expect(
        extension.body,
        `extension ${testCase.method} ${testCase.status} acquired a response body`,
      ).toBeNull();
    }
  });
});
