import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCookieStore = {
  getAll: vi.fn(() => []),
  set: vi.fn(),
};

const mockSignOut = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _supabaseUrl: string,
      _supabaseAnonKey: string,
      options: {
        cookies: {
          setAll: (
            cookiesToSet: Array<{
              name: string;
              value: string;
              options?: Record<string, unknown>;
            }>
          ) => void;
        };
      }
    ) => ({
      auth: {
        signOut: async (params: { scope: string }) => {
          const result = await mockSignOut(params);
          if (result?.cookiesToSet) {
            options.cookies.setAll(result.cookiesToSet);
          }
        },
      },
    })
  ),
}));

describe("POST /auth/signout", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockClear();
    mockCookieStore.set.mockClear();
    mockSignOut.mockReset();
  });

  it("returns the cookie-clearing response on redirect", async () => {
    mockSignOut.mockResolvedValue({
      cookiesToSet: [
        {
          name: "sb-local-auth-token",
          value: "",
          options: { path: "/", maxAge: 0 },
        },
      ],
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost:3000/auth/signout"));

    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(response.headers.get("set-cookie")).toContain("sb-local-auth-token=");
  });
});
