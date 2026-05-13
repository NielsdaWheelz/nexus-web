import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("redirects unauthenticated protected requests to login and preserves the destination", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/conversations?view=compact")
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fconversations%3Fview%3Dcompact"
    );
  });

  it("allows public routes without redirecting unauthenticated users", async () => {
    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/login?next=%2Flibraries")
    );

    expect(response.headers.get("location")).toBeNull();
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
      new NextRequest("http://localhost:3000/libraries")
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("allows protected requests with a local session when Supabase Auth has a transient server failure", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { status: 504 },
    });

    const { updateSession } = await import("./middleware");
    const request = new NextRequest("http://localhost:3000/libraries", {
      headers: {
        cookie: "sb-project-ref-auth-token=base64-session",
      },
    });
    const response = await updateSession(request);

    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects protected requests without a local session when Supabase Auth has a transient server failure", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { status: 504 },
    });

    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/libraries")
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Flibraries"
    );
  });
});
