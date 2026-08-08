import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { GET } from "./route";

const originalEnvironment = { ...process.env };

function refreshableCookie(): string {
  const value = Buffer.from(
    JSON.stringify({
      access_token: "unverified-access-token",
      expires_at: 0,
      refresh_token: "refresh-token",
      token_type: "bearer",
    }),
  )
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `sb-fixture-auth-token=base64-${value}`;
}

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("extension connect start recovery", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS =
      "https://extension.example";
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = "https://nexus.example";
  });

  it("enters canonical recovery while preserving the extension handoff target", async () => {
    const response = await GET(
      new Request(
        "https://nexus.example/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.example%2F",
        {
          headers: {
            host: "nexus.example",
            cookie: refreshableCookie(),
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://nexus.example/auth/session/recover?next=%2Fextension%2Fconnect%2Fstart%3Fredirect_uri%3Dhttps%253A%252F%252Fextension.example%252F",
    );
  });

  it("rejects an unallowlisted extension redirect before session recovery", async () => {
    const response = await GET(
      new Request(
        "https://nexus.example/extension/connect/start?redirect_uri=https%3A%2F%2Fattacker.example%2F",
        { headers: { host: "nexus.example", cookie: refreshableCookie() } },
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "E_FORBIDDEN",
        message: "Extension redirect origin is not allowed",
      },
    });
  });
});
