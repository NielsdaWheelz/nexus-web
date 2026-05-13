import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetUser = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}));

describe("updateSession", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redirects protected requests without an auth cookie and preserves the destination", async () => {
    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/conversations?view=compact")
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fconversations%3Fview%3Dcompact"
    );
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("allows public routes without redirecting unauthenticated users", async () => {
    const { updateSession } = await import("./middleware");
    const responses = await Promise.all([
      updateSession(
        new NextRequest("http://localhost:3000/login?next=%2Flibraries")
      ),
      updateSession(new NextRequest("http://localhost:3000/terms")),
      updateSession(new NextRequest("http://localhost:3000/privacy")),
      updateSession(
        new NextRequest("http://localhost:3000/extension/connect/start")
      ),
    ]);

    expect(
      responses.every((response) => !response.headers.get("location"))
    ).toBe(true);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("allows unauthenticated API routes through so route handlers can return JSON errors", async () => {
    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/api/libraries")
    );

    expect(response.headers.get("location")).toBeNull();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("allows authenticated protected requests through", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/libraries", {
        headers: {
          cookie: "sb-project-ref-auth-token=base64-session",
        },
      })
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects protected requests with a stale or fake auth cookie", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { updateSession } = await import("./middleware");
    const request = new NextRequest("http://localhost:3000/libraries", {
      headers: {
        cookie: "sb-project-ref-auth-token=base64-session",
      },
    });
    const response = await updateSession(request);

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Flibraries"
    );
  });

  it("redirects protected requests when Supabase Auth fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetUser.mockRejectedValue(new Error("auth unavailable"));

    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/libraries", {
        headers: {
          cookie: "sb-project-ref-auth-token=base64-session",
        },
      })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Flibraries"
    );
  });
});
