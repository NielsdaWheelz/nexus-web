import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const mockHeaders = vi.fn();
const mockRedirect = vi.fn((url: string): never => {
  throw new Error(`redirect:${url}`);
});

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}));

describe("requireAuthenticatedUser", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockHeaders.mockReset();
    mockRedirect.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns when Supabase verifies the user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const { requireAuthenticatedUser } = await import("./protected");
    await expect(requireAuthenticatedUser()).resolves.toBeUndefined();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockHeaders).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated users to login with the requested path", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockHeaders.mockResolvedValue(
      new Headers({ "x-nexus-request-path": "/browse?scope=library" })
    );

    const { requireAuthenticatedUser } = await import("./protected");

    await expect(requireAuthenticatedUser()).rejects.toThrow(
      "redirect:/login?next=%2Fbrowse%3Fscope%3Dlibrary"
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      "/login?next=%2Fbrowse%3Fscope%3Dlibrary"
    );
  });

  it("redirects when Supabase Auth fails closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetUser.mockRejectedValue(new Error("auth unavailable"));
    mockHeaders.mockResolvedValue(
      new Headers({ "x-nexus-request-path": "/libraries" })
    );

    const { requireAuthenticatedUser } = await import("./protected");

    await expect(requireAuthenticatedUser()).rejects.toThrow(
      "redirect:/login?next=%2Flibraries"
    );
    expect(mockRedirect).toHaveBeenCalledWith("/login?next=%2Flibraries");
  });
});
