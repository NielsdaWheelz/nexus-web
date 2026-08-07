import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { AUTH_ENDED_FEEDBACK_COOKIE } from "./messages";
import { finalizeSessionResponse } from "./session-response";

describe("session response finalizer", () => {
  it("preserves credentials and overrides upstream cache policy", () => {
    const response = NextResponse.json(
      { error: "unavailable" },
      {
        status: 503,
        headers: {
          "Cache-Control": "public, max-age=3600",
          Vary: "Accept-Encoding",
        },
      },
    );

    expect(
      finalizeSessionResponse(response, { kind: "Preserve" }),
    ).toBe(response);
    expect(response.cookies.getAll()).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("emits every successor cookie", () => {
    const response = new NextResponse(null, { status: 204 });
    finalizeSessionResponse(response, {
      kind: "Rotate",
      cookiesToSet: [
        { name: "session.0", value: "first", options: { path: "/" } },
        { name: "session.1", value: "second", options: { path: "/" } },
      ],
    });

    expect(response.cookies.getAll()).toEqual([
      expect.objectContaining({ name: "session.0", value: "first" }),
      expect.objectContaining({ name: "session.1", value: "second" }),
    ]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("expires every terminal cookie and emits feedback when requested", () => {
    const response = new NextResponse(null, { status: 401 });
    finalizeSessionResponse(response, {
      kind: "Clear",
      cookieNames: ["session", "session.0"],
      feedback: true,
    });

    expect(response.cookies.get("session")).toMatchObject({
      name: "session",
      value: "",
    });
    expect(response.cookies.get("session.0")).toMatchObject({
      name: "session.0",
      value: "",
    });
    expect(response.cookies.get(AUTH_ENDED_FEEDBACK_COOKIE)).toMatchObject({
      name: AUTH_ENDED_FEEDBACK_COOKIE,
      value: "1",
    });
  });

  it("does not emit terminal feedback for ordinary absence", () => {
    const response = new NextResponse(null, { status: 401 });
    finalizeSessionResponse(response, {
      kind: "Clear",
      cookieNames: [],
      feedback: false,
    });

    expect(response.cookies.getAll()).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
