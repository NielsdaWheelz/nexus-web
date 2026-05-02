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
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/login?next=%2Flibraries")
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("allows unauthenticated API routes through so route handlers can return JSON errors", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/api/libraries")
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("allows authenticated protected requests through", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/libraries")
    );

    expect(response.headers.get("location")).toBeNull();
  });
});
