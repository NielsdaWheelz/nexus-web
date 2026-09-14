import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthDependencyError } from "@/lib/auth/session-response";
import { AUTH_ENDED_FEEDBACK_COOKIE } from "@/lib/auth/messages";
import {
  proxyAccountBoundToFastAPIWithDeps,
  proxyCacheableMediaAssetToFastAPIWithDeps,
  proxyExtensionToFastAPI,
  proxyMediaAssetToFastAPIWithDeps,
  proxyToFastAPIWithDeps,
} from "./proxy";

const REQUEST_ID = "proxy-unit-request";
const ACCESS_TOKEN = "proxy-unit-access-token";
const AUTH_COOKIE = "sb-fixture-auth-token";
const originalEnvironment = { ...process.env };

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
  overrides: Partial<Parameters<typeof proxyToFastAPIWithDeps>[2]> = {},
): Parameters<typeof proxyToFastAPIWithDeps>[2] {
  return {
    readSession: () => ({
      state: "active",
      accessToken: ACCESS_TOKEN,
      canRefresh: false,
      expiresAt: 4_102_444_800,
      cookieNames: [],
    }),
    refreshSession: async () => {
      throw new Error("active proxy unexpectedly refreshed its session");
    },
    fetch: externalFetch,
    generateRequestId: () => REQUEST_ID,
    appPublicOrigin: "http://localhost:3000",
    config: {
      fastApiBaseUrl: "http://localhost:8000",
      internalSecret: "proxy-unit-internal-secret",
    },
    ...overrides,
  };
}

function activeSessionCookie(accessToken = "successor-access-token") {
  const value = Buffer.from(
    JSON.stringify({
      access_token: accessToken,
      expires_at: 4_102_444_800,
      refresh_token: "successor-refresh-token",
      token_type: "bearer",
    }),
  )
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return {
    name: AUTH_COOKIE,
    value: `base64-${value}`,
    options: { httpOnly: true, path: "/" },
  } as const;
}

function expectCanonicalPrivateHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("expires")).toBe("0");
  expect(response.headers.get("vary")).toBe("Cookie");
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
    process.env = { ...originalEnvironment };
  });

  it.each([502, 503, 504])("normalizes an unenveloped gateway %s with private request context", async (status) => {
    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/one"),
      "/media/one",
      authenticatedDeps(async () => new Response("upstream unavailable", { status })),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: {
        code: status === 504 ? "E_UPSTREAM_TIMEOUT" : "E_UPSTREAM",
        message: `Request failed with status ${status}`,
        request_id: REQUEST_ID,
      },
    });
    expectCanonicalPrivateHeaders(response);
  });

  it("preserves owned gateway metadata and drops obsolete representation headers", async () => {
    const envelope = {
      error: { code: "E_READ_CAPACITY", message: "Try again", request_id: "upstream-request" },
      retry_after_seconds: 2,
    };
    for (const method of ["GET", "HEAD"]) {
      const response = await proxyToFastAPIWithDeps(
        new Request("http://localhost:3000/api/media/one", { method }),
        "/media/one",
        authenticatedDeps(async () => new Response(JSON.stringify(envelope), {
          status: 503,
          headers: { etag: "old-entity", "content-range": "bytes 0-5/6", "accept-ranges": "bytes", "content-disposition": "attachment" },
        })),
      );
      for (const header of ["etag", "content-range", "accept-ranges", "content-disposition", "content-length"]) {
        expect(response.headers.get(header)).toBeNull();
      }
      if (method === "HEAD") expect(response.body).toBeNull();
      else expect(await response.json()).toEqual(envelope);
    }
  });

  it("delivers a terminal reader oversize refusal with the exact limit its content broke", async () => {
    // A 422 is the API's own permanent answer, not an unowned gateway outage,
    // so it keeps its code and `details`: the browser names the broken limit
    // from them and must not offer a retry.
    const envelope = {
      error: {
        code: "E_READER_CONTENT_TOO_LARGE",
        message: "Reader query exceeds response capacity",
        request_id: "upstream-request",
        details: { limit: "index_bytes", limit_value: 262144, measured: 393216 },
      },
    };
    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/one/reader-publications/2/find", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: "{}",
      }),
      "/media/one/reader-publications/2/find",
      authenticatedDeps(async () => new Response(JSON.stringify(envelope), {
        status: 422, headers: { "content-type": "application/json" },
      })),
    );
    expect(response.status).toBe(422);
    expect(await response.json(), "the reader lost the limit its content broke").toEqual(envelope);
    expect(response.headers.get("retry-after"), "a permanent refusal advertised retry guidance").toBeNull();
    expectCanonicalPrivateHeaders(response);
  });

  it("preserves byte-serving integrity and removes digest identity when replacing failed bytes", async () => {
    for (const status of [200, 503]) {
      const response = await proxyMediaAssetToFastAPIWithDeps(
        new Request("http://localhost:3000/api/media/one/reader-publication"),
        "/media/one/reader-publication",
        authenticatedDeps(async (_input, init) => {
          expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity");
          return new Response("{}", {
            status,
            headers: {
              "content-type": "application/json", "content-length": "2",
              "content-digest": "sha-256=:fixture:", "x-nexus-reader-generation": "7",
              "x-nexus-image-width": "2", "x-nexus-image-height": "6",
              "cache-control": "private, no-store, no-transform", "Retry-After": "1",
            },
          });
        }),
      );
      expect(response.headers.get("retry-after"), "proxy discarded read admission guidance").toBe("1");
      expect(response.headers.get("cache-control"), "session finalization reenabled member compression")
        .toBe("private, no-store, no-transform");
      for (const [header, value] of [["content-length", "2"], ["content-digest", "sha-256=:fixture:"], ["x-nexus-reader-generation", "7"], ["x-nexus-image-width", "2"], ["x-nexus-image-height", "6"]]) {
        expect(response.headers.get(header), "replacement error retained obsolete member identity")
          .toBe(status === 200 ? value : null);
      }
      if (status === 200) expect(await response.text()).toBe("{}");
      else expect((await response.json()).error.code).toBe("E_UPSTREAM");
    }
  });

  it("delivers the artwork lane's own freshness to the browser and keeps members session-private", async () => {
    // The API retains no image bytes, so the browser's private window is the
    // only cache in the system; a member is session state and must not be kept.
    const upstream = (cacheControl: string): typeof fetch => async () =>
      new Response("bytes", {
        headers: { "content-type": "image/png", "content-length": "5", "cache-control": cacheControl },
      });

    const artwork = await proxyCacheableMediaAssetToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/image?url=https://example.test/cover.png"),
      "/media/image",
      authenticatedDeps(upstream("private, max-age=86400, no-transform")),
    );
    expect(
      artwork.headers.get("cache-control"),
      "the browser lost the private freshness the deleted API cache was traded for",
    ).toBe("private, max-age=86400, no-transform");

    const epubAsset = await proxyCacheableMediaAssetToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/one/assets/cover.png"),
      "/media/one/assets/cover.png",
      authenticatedDeps(upstream("private, max-age=86400")),
    );
    expect(
      epubAsset.headers.get("cache-control"),
      "the identity byte lane forwarded a representation a hop may recode",
    ).toBe("private, max-age=86400, no-transform");

    const member = await proxyMediaAssetToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/one/reader-publications/7/descriptor"),
      "/media/one/reader-publications/7/descriptor",
      authenticatedDeps(upstream("private, max-age=86400")),
    );
    expect(
      member.headers.get("cache-control"),
      "a publication member lane adopted an upstream freshness window",
    ).toBe("private, no-store, no-transform");

    const failed = await proxyCacheableMediaAssetToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/image?url=https://example.test/cover.png"),
      "/media/image",
      authenticatedDeps(async () => new Response("gateway page", {
        status: 503, headers: { "cache-control": "private, max-age=86400, no-transform" },
      })),
    );
    expect(
      failed.headers.get("cache-control"),
      "a replaced failure body inherited the representation's freshness",
    ).toBe("private, no-store, no-transform");
  });

  it("normalizes a gateway body without materializing it past the envelope ceiling", async () => {
    const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
    let produced = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 64 * 1024) {
          controller.close();
          return;
        }
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/one"),
      "/media/one",
      authenticatedDeps(async () => new Response(body, { status: 503 })),
    );

    expect(await response.json(), "an oversized gateway body was adopted as an owned envelope").toEqual({
      error: { code: "E_UPSTREAM", message: "Request failed with status 503", request_id: REQUEST_ID },
    });
    expect(cancelled, "the BFF drained a gateway body it had already refused").toBe(true);
    expect(produced, "the BFF buffered the whole gateway body while classifying it").toBeLessThan(64 * 1024);
  });

  it("forwards offline reader attestation only through its narrow route policy", async () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    let ordinaryExpectedAccount: string | null = null;
    const ordinary = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/one/document-map", {
        headers: { "X-Nexus-Expected-Account-Id": accountId },
      }),
      "/media/one/document-map",
      authenticatedDeps(async (_input, init) => {
        ordinaryExpectedAccount = new Headers(init?.headers).get(
          "x-nexus-expected-account-id",
        );
        return new Response('{"data":{}}', {
          headers: {
            "content-type": "application/json",
            "nexus-account-id": accountId,
            "nexus-reader-generation": "7",
          },
        });
      }),
    );

    let offlineExpectedAccount: string | null = null;
    const offline = await proxyAccountBoundToFastAPIWithDeps(
      new Request("http://localhost:3000/api/media/one/offline-reader-state", {
        headers: { "X-Nexus-Expected-Account-Id": accountId },
      }),
      "/media/one/offline-reader-state",
      authenticatedDeps(async (_input, init) => {
        offlineExpectedAccount = new Headers(init?.headers).get(
          "x-nexus-expected-account-id",
        );
        return new Response('{"data":{}}', {
          headers: {
            "content-type": "application/json",
            "nexus-account-id": accountId,
            "nexus-reader-generation": "7",
          },
        });
      }),
    );

    expect(ordinaryExpectedAccount).toBeNull();
    expect(ordinary.headers.get("nexus-account-id")).toBeNull();
    expect(ordinary.headers.get("nexus-reader-generation")).toBeNull();
    expect(offlineExpectedAccount).toBe(accountId);
    expect(offline.headers.get("nexus-account-id")).toBe(accountId);
    expect(offline.headers.get("nexus-reader-generation")).toBe("7");
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

  it.each([200, 401, 499, 502, 504])(
    "makes every authenticated FastAPI response private and uncacheable: %i",
    async (status) => {
      let forwardedBody: string | undefined;
      const response = await proxyToFastAPIWithDeps(
        new Request("http://localhost:3000/api/mutation", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: '{"preserve":"this body"}',
        }),
        "/mutation",
        authenticatedDeps(async (_input, init) => {
          const body = init?.body;
          forwardedBody = body instanceof ArrayBuffer
            ? new TextDecoder().decode(body)
            : undefined;
          return new Response(status === 499 ? null : "upstream", {
            status,
            headers: {
              "cache-control": "public, max-age=3600",
              pragma: "upstream",
              expires: "never",
              vary: "Accept-Encoding",
            },
          });
        }),
      );

      expect(response.status).toBe(status);
      expect(forwardedBody).toBe('{"preserve":"this body"}');
      expectCanonicalPrivateHeaders(response);
      expect(
        response.headers.get("location"),
        "BFF and mutation requests must return their direct HTTP result, never an auth redirect",
      ).toBeNull();
    },
  );

  it.each([200, 499, 502, 504])(
    "refreshes before consuming a mutation body and preserves successor credentials on downstream %i",
    async (status) => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
      const request = new Request("http://localhost:3000/api/mutation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: '{"mutation":"must survive"}',
      });
      let bodyWasConsumedBeforeRefresh = true;
      let forwardedAuthorization: string | null = null;
      let forwardedBody: string | null = null;
      const successor = activeSessionCookie();

      const response = await proxyToFastAPIWithDeps(
        request,
        "/mutation",
        authenticatedDeps(
          async (_input, init) => {
            forwardedAuthorization = new Headers(init?.headers).get(
              "authorization",
            );
            forwardedBody =
              init?.body instanceof ArrayBuffer
                ? new TextDecoder().decode(init.body)
                : null;
            return new Response(status === 499 ? null : "upstream", { status });
          },
          {
            readSession: () => ({
              state: "refreshable",
              cookieNames: [AUTH_COOKIE, `${AUTH_COOKIE}.0`],
            }),
            refreshSession: async () => {
              bodyWasConsumedBeforeRefresh = request.bodyUsed;
              return { kind: "Refreshed", cookiesToSet: [successor] };
            },
          },
        ),
      );

      expect(bodyWasConsumedBeforeRefresh).toBe(false);
      expect(forwardedAuthorization).toBe("Bearer successor-access-token");
      expect(forwardedBody).toBe('{"mutation":"must survive"}');
      expect(response.status).toBe(status);
      expect(response.headers.get("set-cookie")).toContain(
        `${AUTH_COOKIE}=${successor.value}`,
      );
      expectCanonicalPrivateHeaders(response);
      expect(response.headers.get("location")).toBeNull();
    },
  );

  it("preserves a refreshed session when FastAPI transport fails", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    const successor = activeSessionCookie();
    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/resource"),
      "/resource",
      authenticatedDeps(
        async () => {
          throw new TypeError("synthetic transport failure");
        },
        {
          readSession: () => ({
            state: "refreshable",
            cookieNames: [AUTH_COOKIE],
          }),
          refreshSession: async () => ({
            kind: "Refreshed",
            cookiesToSet: [successor],
          }),
        },
      ),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "E_UPSTREAM" },
    });
    expect(response.headers.get("set-cookie")).toContain(
      `${AUTH_COOKIE}=${successor.value}`,
    );
    expectCanonicalPrivateHeaders(response);
  });

  it("projects a trusted FastAPI 401 as terminal and clears current and successor cookies", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    const successor = activeSessionCookie();
    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/resource"),
      "/resource",
      authenticatedDeps(async () => new Response("provider detail", { status: 401 }), {
        readSession: () => ({
          state: "refreshable",
          cookieNames: [AUTH_COOKIE, `${AUTH_COOKIE}.0`],
        }),
        refreshSession: async () => ({
          kind: "Refreshed",
          cookiesToSet: [successor],
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "E_UNAUTHENTICATED",
        message: "Authentication required",
        request_id: REQUEST_ID,
      },
    });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${AUTH_COOKIE}=;`);
    expect(setCookie).toContain(`${AUTH_COOKIE}.0=;`);
    expect(setCookie).toContain(`${AUTH_ENDED_FEEDBACK_COOKIE}=1`);
    expect(setCookie).not.toContain(successor.value);
    expectCanonicalPrivateHeaders(response);
  });

  it.each([
    {
      name: "dependency uncertainty",
      refresh: async () => {
        throw new AuthDependencyError();
      },
      status: 503,
      code: "E_AUTH_UNAVAILABLE",
    },
    {
      name: "refresh defect",
      refresh: async () => {
        throw new Error("synthetic refresh defect");
      },
      status: 500,
      code: "E_INTERNAL",
    },
  ])(
    "preserves credentials and the unread request body on $name",
    async ({ refresh, status, code }) => {
      const request = new Request("http://localhost:3000/api/mutation", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
        body: "sensitive mutation",
      });
      let reachedFastApi = false;
      const response = await proxyToFastAPIWithDeps(
        request,
        "/mutation",
        authenticatedDeps(
          async () => {
            reachedFastApi = true;
            return new Response();
          },
          {
            readSession: () => ({
              state: "refreshable",
              cookieNames: [AUTH_COOKIE],
            }),
            refreshSession: refresh,
          },
        ),
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
      expect(request.bodyUsed).toBe(false);
      expect(reachedFastApi).toBe(false);
      expect(response.headers.get("set-cookie")).toBeNull();
      expectCanonicalPrivateHeaders(response);
      expect(response.headers.get("location")).toBeNull();
    },
  );

  it.each([
    {
      name: "ordinary absence",
      session: {
        state: "anonymous" as const,
        reason: "missing" as const,
        cookieNames: [],
      },
      feedback: false,
    },
    {
      name: "corrupt credential",
      session: {
        state: "anonymous" as const,
        reason: "malformed" as const,
        cookieNames: [AUTH_COOKIE],
      },
      feedback: true,
    },
    {
      name: "terminal credential",
      session: {
        state: "ended" as const,
        reason: "no_refresh_token" as const,
        cookieNames: [AUTH_COOKIE],
      },
      feedback: true,
    },
  ])("returns a direct terminal 401 for $name", async ({ session, feedback }) => {
    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/resource"),
      "/resource",
      authenticatedDeps(async () => {
        throw new Error("unauthenticated request reached FastAPI");
      }, { readSession: () => session }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "E_UNAUTHENTICATED" },
    });
    const setCookie = response.headers.get("set-cookie");
    if (feedback) {
      expect(setCookie).toContain(`${AUTH_COOKIE}=;`);
      expect(setCookie).toContain(`${AUTH_ENDED_FEEDBACK_COOKIE}=1`);
    } else {
      expect(setCookie).toBeNull();
    }
    expectCanonicalPrivateHeaders(response);
    expect(response.headers.get("location")).toBeNull();
  });
});
