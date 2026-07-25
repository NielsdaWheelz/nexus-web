import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";
import { __resetEnvForTests } from "@/lib/env";
import { POST } from "./route";

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

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MUTATION_ID = "22222222-2222-4222-8222-222222222222";

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

function activityBody(extra: Record<string, unknown> = {}): object {
  return {
    clientMutationId: MUTATION_ID,
    mediaRef: `media:${MEDIA_ID}`,
    deviceClass: "Desktop",
    batch: {
      modality: "Viewing",
      spans: [
        {
          occurredAt: "2026-07-24T20:00:00.000Z",
          durationMs: 10_000,
        },
      ],
    },
    ...extra,
  };
}

function postRequest(body: string): Request {
  return new Request("http://localhost:3000/api/consumption/activity", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: authCookie(),
      origin: "http://localhost:3000",
    },
    body,
  });
}

describe("POST /api/consumption/activity", () => {
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

  it("injects nx_device into the strict backend body", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      postRequest(JSON.stringify(activityBody())),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.local/consumption/activity");
    expect(
      JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)),
    ).toEqual({
      clientMutationId: MUTATION_ID,
      mediaId: MEDIA_ID,
      deviceId: "private-device-id",
      deviceClass: "Desktop",
      batch: (activityBody() as { batch: unknown }).batch,
    });
  });

  it("rejects client-owned device identity before proxying", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      postRequest(
        JSON.stringify(activityBody({ deviceId: "client-controlled" })),
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized body with the capture error contract", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(postRequest(" ".repeat(48_001)));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "E_CAPTURE_TOO_LARGE",
        message: "Activity batch is too large",
      },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
