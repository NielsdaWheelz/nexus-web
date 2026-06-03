import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_CHANGE_FAILURE_MESSAGE } from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";
import { changeEmailAction } from "./actions";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

const mockCreateClient = vi.mocked(createClient);
const mockHeaders = vi.mocked(headers);
type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
type SupabaseAuthMock = Partial<SupabaseServerClient["auth"]>;

function mockSupabaseAuth(auth: SupabaseAuthMock) {
  mockCreateClient.mockResolvedValue({ auth } as SupabaseServerClient);
}

const AUTH_ALLOWED_REDIRECT_ORIGINS = "AUTH_ALLOWED_REDIRECT_ORIGINS";

beforeEach(() => {
  mockCreateClient.mockReset();
  mockHeaders.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("changeEmailAction", () => {
  it("fails closed without any Supabase side effect when the host origin is spoofed", async () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://app.example.com");
    mockHeaders.mockResolvedValue(new Headers({ host: "evil.example.com" }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await changeEmailAction({ email: "ada@example.com" });

    expect(result).toEqual({ ok: false, error: EMAIL_CHANGE_FAILURE_MESSAGE });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "auth_email_change_origin_rejected",
      expect.objectContaining({ reason: expect.any(String) })
    );
  });

  it("returns EMAIL_CHANGE_FAILURE_MESSAGE for an invalid email before resolving the origin", async () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://app.example.com");

    const result = await changeEmailAction({ email: "not-an-email" });

    expect(result).toEqual({ ok: false, error: EMAIL_CHANGE_FAILURE_MESSAGE });
    expect(mockHeaders).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("calls updateUser with the normalized email and an allowlisted emailRedirectTo", async () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://app.example.com");
    mockHeaders.mockResolvedValue(new Headers({ host: "app.example.com" }));
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    mockSupabaseAuth({ updateUser });

    const result = await changeEmailAction({ email: "Ada@Example.com" });

    expect(result).toEqual({ ok: true });
    expect(updateUser).toHaveBeenCalledWith(
      { email: "ada@example.com" },
      {
        emailRedirectTo:
          "https://app.example.com/auth/callback?next=%2Fsettings%2Faccount",
      }
    );
  });
});
