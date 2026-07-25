import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";
import { __resetEnvForTests } from "@/lib/env";
import { proxyConsumptionRead } from "./historyBff.server";

vi.mock("server-only", () => ({}));

const requestCookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string): { value: string } | undefined => {
      const value = requestCookies.get(name);
      return value === undefined ? undefined : { value };
    },
  })),
}));

function authCookie(): string {
  const payload = Buffer.from(
    JSON.stringify({
      access_token: "test-access-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
    }),
    "utf8",
  ).toString("base64url");
  return `sb-project-ref-auth-token=base64-${payload}`;
}

function getRequest(search = ""): Request {
  return new Request(
    `http://localhost:3000/api/consumption/stats${search}`,
    { headers: { cookie: authCookie() } },
  );
}

describe("Consumption history read BFF", () => {
  beforeEach(() => {
    requestCookies.clear();
    requestCookies.set(DEVICE_COOKIE_NAME, "private-device-id");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    vi.stubEnv("FASTAPI_BASE_URL", "http://api.local");
    vi.stubEnv("NEXUS_ENV", "test");
    __resetEnvForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    __resetEnvForTests();
  });

  it("injects the private current device without exposing it in the response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { activity: {} } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyConsumptionRead(
      getRequest("?end=2026-07-25T00%3A00%3A00Z&timeZone=America%2FLos_Angeles"),
      "/consumption/stats",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [url] = fetchMock.mock.calls[0]!;
    const forwarded = new URL(String(url));
    expect(forwarded.searchParams.get("currentDeviceId")).toBe(
      "private-device-id",
    );
    expect(await response.text()).not.toContain("private-device-id");
  });

  it("rejects browser attempts to supply the server-owned device value", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyConsumptionRead(
      getRequest("?currentDeviceId=spoofed"),
      "/consumption/stats",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a missing authenticated device cookie as a private invariant defect", async () => {
    requestCookies.clear();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyConsumptionRead(
      getRequest(),
      "/consumption/sessions",
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
