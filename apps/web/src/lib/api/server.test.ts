import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { __resetEnvForTests } from "@/lib/env";
import { callFastAPI } from "./server";

// server-only is the React/Next marker package; its module body throws on
// import outside a Server Component. Neutralize the marker so callFastAPI can
// be exercised under the node test runner.
vi.mock("server-only", () => ({}));

// The only external boundaries callFastAPI touches before fetch: the request
// cookie store (next/headers) and the session-cookie reader. Mock those; drive
// the internal-API config through the real getEnv() via its env-stub seam
// (__resetEnvForTests + vi.stubEnv), so the call reaches the real fetch + timeout path.
const cookieStore = {
  getAll: vi.fn((): { name: string; value: string }[] => []),
};
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

vi.mock("@/lib/auth/session-cookie", () => ({
  readSupabaseSessionCookie: vi.fn(() => ({
    state: "active",
    accessToken: "server-token",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    cookieNames: [],
  })),
}));

describe("callFastAPI timeoutMs", () => {
  beforeEach(() => {
    __resetEnvForTests();
    vi.stubEnv("FASTAPI_BASE_URL", "http://x");
    cookieStore.getAll.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    __resetEnvForTests();
  });

  it("aborts the upstream request and rejects with a 504 E_UPSTREAM_TIMEOUT", async () => {
    let capturedSignal: AbortSignal | undefined;
    // A never-resolving fetch that rejects only once its AbortSignal fires, the
    // way the real fetch behaves when its request is cancelled.
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await callFastAPI("/x", { timeoutMs: 5 }).then(
      () => {
        throw new Error("Expected callFastAPI to reject");
      },
      (caught: unknown) => caught,
    );

    // (a) the underlying request was cancelled, not merely ignored.
    expect(capturedSignal?.aborted).toBe(true);
    // (b) the call rejects with a 504 timeout ApiError.
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(504);
    expect((error as ApiError).code).toBe("E_UPSTREAM_TIMEOUT");
  });
});
