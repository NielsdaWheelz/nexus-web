import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEEP_ONE_SIGN_IN_METHOD_MESSAGE,
  PASSWORD_CHANGE_FAILURE_MESSAGE,
  PASSWORD_REMOVE_FAILURE_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
} from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";
import {
  changePasswordAction,
  removePasswordAction,
  setPasswordAction,
} from "./password-actions";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

const mockCreateClient = vi.mocked(createClient);
type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
type SupabaseAuthMock = Partial<SupabaseServerClient["auth"]>;

function mockSupabaseAuth(auth: SupabaseAuthMock) {
  mockCreateClient.mockResolvedValue({ auth } as SupabaseServerClient);
}

beforeEach(() => {
  mockCreateClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setPasswordAction", () => {
  it("returns PASSWORD_TOO_SHORT_MESSAGE for a password under 12 chars", async () => {
    const updateUser = vi.fn();
    mockSupabaseAuth({ updateUser });

    const result = await setPasswordAction({ password: "shortpw" });

    expect(result).toEqual({ ok: false, error: PASSWORD_TOO_SHORT_MESSAGE });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("maps an updateUser error to PASSWORD_CHANGE_FAILURE_MESSAGE", async () => {
    mockSupabaseAuth({
      updateUser: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: "boom" } }),
    });

    const result = await setPasswordAction({
      password: "correcthorsebattery",
    });

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_CHANGE_FAILURE_MESSAGE,
    });
  });

  it("returns { ok: true } on success", async () => {
    mockSupabaseAuth({
        updateUser: vi
          .fn()
          .mockResolvedValue({ data: {}, error: null }),
    });

    const result = await setPasswordAction({
      password: "correcthorsebattery",
    });

    expect(result).toEqual({ ok: true });
  });
});

// changePasswordAction body is identical to setPasswordAction; cover the
// happy path once to guard against accidental divergence.
describe("changePasswordAction", () => {
  it("returns { ok: true } on success", async () => {
    mockSupabaseAuth({
        updateUser: vi
          .fn()
          .mockResolvedValue({ data: {}, error: null }),
    });

    const result = await changePasswordAction({
      password: "correcthorsebattery",
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("removePasswordAction", () => {
  it("returns PASSWORD_REMOVE_FAILURE_MESSAGE when no email identity exists", async () => {
    mockSupabaseAuth({
        getUserIdentities: vi.fn().mockResolvedValue({
          data: {
            identities: [
              {
                identity_id: "google-id",
                provider: "google",
                created_at: "2026-04-02T00:00:00Z",
                identity_data: { email: "owner@example.com" },
              },
            ],
          },
          error: null,
        }),
        unlinkIdentity: vi.fn(),
    });

    const result = await removePasswordAction();

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_REMOVE_FAILURE_MESSAGE,
    });
  });

  it("returns KEEP_ONE_SIGN_IN_METHOD_MESSAGE when only the email identity remains", async () => {
    mockSupabaseAuth({
        getUserIdentities: vi.fn().mockResolvedValue({
          data: {
            identities: [
              {
                identity_id: "email-id",
                provider: "email",
                created_at: "2026-04-01T00:00:00Z",
                identity_data: { email: "owner@example.com" },
              },
            ],
          },
          error: null,
        }),
        unlinkIdentity: vi.fn(),
    });

    const result = await removePasswordAction();

    expect(result).toEqual({
      ok: false,
      error: KEEP_ONE_SIGN_IN_METHOD_MESSAGE,
    });
  });

  it("maps an unlinkIdentity error to PASSWORD_REMOVE_FAILURE_MESSAGE", async () => {
    mockSupabaseAuth({
        getUserIdentities: vi.fn().mockResolvedValue({
          data: {
            identities: [
              {
                identity_id: "email-id",
                provider: "email",
                created_at: "2026-04-01T00:00:00Z",
                identity_data: { email: "owner@example.com" },
              },
              {
                identity_id: "google-id",
                provider: "google",
                created_at: "2026-04-02T00:00:00Z",
                identity_data: { email: "owner+google@example.com" },
              },
            ],
          },
          error: null,
        }),
        unlinkIdentity: vi
          .fn()
          .mockResolvedValue({ data: null, error: { message: "boom" } }),
    });

    const result = await removePasswordAction();

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_REMOVE_FAILURE_MESSAGE,
    });
  });

  it("returns { ok: true } when unlinkIdentity succeeds", async () => {
    mockSupabaseAuth({
        getUserIdentities: vi.fn().mockResolvedValue({
          data: {
            identities: [
              {
                identity_id: "email-id",
                provider: "email",
                created_at: "2026-04-01T00:00:00Z",
                identity_data: { email: "owner@example.com" },
              },
              {
                identity_id: "google-id",
                provider: "google",
                created_at: "2026-04-02T00:00:00Z",
                identity_data: { email: "owner+google@example.com" },
              },
            ],
          },
          error: null,
        }),
        unlinkIdentity: vi
          .fn()
          .mockResolvedValue({ data: {}, error: null }),
    });

    const result = await removePasswordAction();

    expect(result).toEqual({ ok: true });
  });
});
