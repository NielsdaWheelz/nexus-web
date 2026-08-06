import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGetAll: vi.fn(),
  cookieWrites: [] as unknown[][],
  providerRefresh: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      getAll: mocks.cookieGetAll,
      set: (...args: unknown[]) => {
        mocks.cookieWrites.push(args);
      },
    }),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { refreshSession: mocks.providerRefresh },
  }),
}));

import { refreshSession } from "./refresh";

describe("session refresh failure projection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.cookieGetAll.mockReset();
    mocks.cookieWrites.length = 0;
    mocks.providerRefresh.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    mocks.cookieGetAll.mockReturnValue([
      { name: "sb-fixture-auth-token", value: "presented-session" },
    ]);
  });

  it("preserves a refreshable session when auth-js returns a retryable fetch failure", async () => {
    mocks.providerRefresh.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError("Mutable provider text", 0),
    });

    await expect(refreshSession()).resolves.toEqual({
      status: "failed",
      reason: "timeout",
    });
    expect(mocks.cookieWrites).toEqual([]);
  });
});
