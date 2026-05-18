import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CookieFixture {
  name: string;
  value: string;
}

type SetAllCookie = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

const mockCookieStore = {
  getAll: vi.fn((): CookieFixture[] => []),
  set: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

// One scripted refresh outcome. `refreshSession` consumes the next outcome from
// this queue on every call, so a test can script attempt 1 then attempt 2.
type RefreshOutcome = {
  fetchCount?: number;
  cookiesToSet?: SetAllCookie[];
  error?: { code: string | null; message: string };
  noSession?: boolean;
};

const refreshOutcomes: RefreshOutcome[] = [];
const refreshSessionSpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _supabaseUrl: string,
      _supabaseAnonKey: string,
      options: {
        cookies: { setAll: (cookies: SetAllCookie[]) => void };
        global: { fetch: typeof fetch };
      }
    ) => ({
      auth: {
        refreshSession: async () => {
          refreshSessionSpy();
          const outcome = refreshOutcomes.shift() ?? {};
          for (let index = 0; index < (outcome.fetchCount ?? 0); index += 1) {
            await options.global.fetch(
              `https://supabase.example/auth/v1/token-${index}`
            );
          }
          if (outcome.error) {
            return { data: { user: null, session: null }, error: outcome.error };
          }
          if (outcome.noSession) {
            return { data: { user: null, session: null }, error: null };
          }
          if (outcome.cookiesToSet) {
            options.cookies.setAll(outcome.cookiesToSet);
          }
          return {
            data: { user: { id: "u1" }, session: { access_token: "rotated" } },
            error: null,
          };
        },
      },
    })
  ),
}));

function rotatedCookie(value: string): SetAllCookie[] {
  return [
    {
      name: "sb-local-auth-token",
      value,
      options: { path: "/", httpOnly: true, maxAge: 31_536_000 },
    },
  ];
}

async function importRefresh() {
  return import("./refresh");
}

describe("refreshSession", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockReset();
    mockCookieStore.getAll.mockReturnValue([
      { name: "sb-local-auth-token", value: "base64-presented-token" },
    ]);
    mockCookieStore.set.mockClear();
    refreshSessionSpy.mockClear();
    refreshOutcomes.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the rotated cookies on a successful refresh", async () => {
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("rotated-session") });

    const { refreshSession } = await importRefresh();
    const result = await refreshSession();

    expect(result).toEqual({
      status: "refreshed",
      cookiesToSet: rotatedCookie("rotated-session"),
    });
    expect(refreshSessionSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a typed failure and logs a structured line on an auth error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    refreshOutcomes.push({
      error: { code: "refresh_token_not_found", message: "Refresh Token Not Found" },
    });

    const { refreshSession } = await importRefresh();
    const result = await refreshSession();

    expect(result).toEqual({ status: "failed", reason: "auth_error" });
    expect(errorSpy).toHaveBeenCalledWith("auth_refresh_failed", {
      reason: "auth_error",
      code: "refresh_token_not_found",
    });
    expect(refreshSessionSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a no_session failure when Supabase returns no session and no error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refreshOutcomes.push({ noSession: true });

    const { refreshSession } = await importRefresh();
    const result = await refreshSession();

    expect(result).toEqual({ status: "failed", reason: "no_session" });
  });

  it("retries exactly once on a refresh-token-already-used error and re-reads cookies", async () => {
    refreshOutcomes.push({
      error: { code: "refresh_token_already_used", message: "Already Used" },
    });
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("retry-rotated") });

    const { refreshSession } = await importRefresh();
    const result = await refreshSession();

    expect(result).toEqual({
      status: "refreshed",
      cookiesToSet: rotatedCookie("retry-rotated"),
    });
    // Two attempts total: the first hit "already used", the retry succeeded.
    expect(refreshSessionSpy).toHaveBeenCalledTimes(2);
    // The retry re-reads cookies rather than reusing stale captured state.
    expect(mockCookieStore.getAll).toHaveBeenCalled();
  });

  it("does not retry on an auth error other than already-used", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refreshOutcomes.push({
      error: { code: "refresh_token_not_found", message: "Refresh Token Not Found" },
    });
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("should-not-be-used") });

    const { refreshSession } = await importRefresh();
    const result = await refreshSession();

    expect(result).toEqual({ status: "failed", reason: "auth_error" });
    expect(refreshSessionSpy).toHaveBeenCalledTimes(1);
  });

  it("attempts refresh at most twice even when the retry also fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refreshOutcomes.push({
      error: { code: "refresh_token_already_used", message: "Already Used" },
    });
    refreshOutcomes.push({
      error: { code: "refresh_token_already_used", message: "Already Used" },
    });
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("never") });

    const { refreshSession } = await importRefresh();
    const result = await refreshSession();

    expect(result).toEqual({ status: "failed", reason: "auth_error" });
    expect(refreshSessionSpy).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent callers presenting the same cookie into one refresh", async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    refreshSessionSpy.mockImplementationOnce(async () => {
      await refreshGate;
    });
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("shared-rotated") });

    const { refreshSession } = await importRefresh();
    const first = refreshSession();
    const second = refreshSession();

    releaseRefresh?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({
      status: "refreshed",
      cookiesToSet: rotatedCookie("shared-rotated"),
    });
    expect(secondResult).toBe(firstResult);
    // Both callers shared one Supabase refresh.
    expect(refreshSessionSpy).toHaveBeenCalledTimes(1);
  });

  it("does not share a refresh between callers presenting different cookies", async () => {
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("first-rotated") });
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("second-rotated") });

    const { refreshSession } = await importRefresh();

    mockCookieStore.getAll.mockReturnValueOnce([
      { name: "sb-local-auth-token", value: "base64-token-a" },
    ]);
    const firstResult = await refreshSession();

    mockCookieStore.getAll.mockReturnValueOnce([
      { name: "sb-local-auth-token", value: "base64-token-b" },
    ]);
    const secondResult = await refreshSession();

    expect(firstResult).toEqual({
      status: "refreshed",
      cookiesToSet: rotatedCookie("first-rotated"),
    });
    expect(secondResult).toEqual({
      status: "refreshed",
      cookiesToSet: rotatedCookie("second-rotated"),
    });
    expect(refreshSessionSpy).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight entry so a later call performs a fresh refresh", async () => {
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("first") });
    refreshOutcomes.push({ cookiesToSet: rotatedCookie("second") });

    const { refreshSession } = await importRefresh();

    await refreshSession();
    await refreshSession();

    expect(refreshSessionSpy).toHaveBeenCalledTimes(2);
  });

  it("fails with a timeout when the refresh exceeds the operation deadline", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    });
    refreshOutcomes.push({ fetchCount: 1 });

    const { refreshSession } = await importRefresh();
    const resultPromise = refreshSession();

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result).toEqual({ status: "failed", reason: "timeout" });
    expect(errorSpy).toHaveBeenCalledWith("auth_refresh_failed", {
      reason: "timeout",
    });
  });
});
