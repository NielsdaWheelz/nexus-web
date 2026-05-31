import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
  KEEP_ONE_SIGN_IN_METHOD_MESSAGE,
  PASSWORD_CHANGE_FAILURE_MESSAGE,
  PASSWORD_REMOVE_FAILURE_MESSAGE,
  PASSWORD_SIGN_IN_FAILURE_MESSAGE,
  PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE,
  PASSWORD_SIGN_UP_FAILURE_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
} from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";
import {
  changePasswordAction,
  removePasswordAction,
  setPasswordAction,
  signInWithPasswordAction,
  signUpWithPasswordAction,
} from "./password-actions";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  }),
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

describe("signInWithPasswordAction", () => {
  it("maps an unknown upstream error to PASSWORD_SIGN_IN_FAILURE_MESSAGE", async () => {
    mockSupabaseAuth({
        signInWithPassword: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "unrecognized upstream failure" },
        }),
    });

    const result = await signInWithPasswordAction({
      email: "user@example.com",
      password: "correcthorsebattery",
    });

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_SIGN_IN_FAILURE_MESSAGE,
    });
  });

  it("maps 'invalid login credentials' upstream error to PASSWORD_SIGN_IN_FAILURE_MESSAGE", async () => {
    mockSupabaseAuth({
        signInWithPassword: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "Invalid login credentials" },
        }),
    });

    const result = await signInWithPasswordAction({
      email: "user@example.com",
      password: "wrong-password-1",
    });

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_SIGN_IN_FAILURE_MESSAGE,
    });
  });

  it("redirects to a safe nextPath on success", async () => {
    mockSupabaseAuth({
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ data: { session: {} }, error: null }),
    });

    let thrown: unknown = null;
    try {
      await signInWithPasswordAction({
        email: "user@example.com",
        password: "correcthorsebattery",
        nextPath: "/foo",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("redirect:/foo");
  });

  it("redirects to /libraries when nextPath is missing", async () => {
    mockSupabaseAuth({
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ data: { session: {} }, error: null }),
    });

    let thrown: unknown = null;
    try {
      await signInWithPasswordAction({
        email: "user@example.com",
        password: "correcthorsebattery",
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("redirect:/libraries");
  });

  it("ignores an unsafe protocol-relative nextPath and redirects to /libraries", async () => {
    mockSupabaseAuth({
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ data: { session: {} }, error: null }),
    });

    let thrown: unknown = null;
    try {
      await signInWithPasswordAction({
        email: "user@example.com",
        password: "correcthorsebattery",
        nextPath: "//evil.com",
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("redirect:/libraries");
  });

  it("ignores an unsafe absolute-URL nextPath and redirects to /libraries", async () => {
    mockSupabaseAuth({
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ data: { session: {} }, error: null }),
    });

    let thrown: unknown = null;
    try {
      await signInWithPasswordAction({
        email: "user@example.com",
        password: "correcthorsebattery",
        nextPath: "http://evil.com/x",
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("redirect:/libraries");
  });
});

describe("signUpWithPasswordAction", () => {
  it("returns PASSWORD_TOO_SHORT_MESSAGE for a password under 12 chars and never calls Supabase", async () => {
    const signUp = vi.fn();
    mockSupabaseAuth({ signUp });

    const result = await signUpWithPasswordAction({
      email: "user@example.com",
      password: "shortpw",
      displayName: "Alice",
    });

    expect(result).toEqual({ ok: false, error: PASSWORD_TOO_SHORT_MESSAGE });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("returns DISPLAY_NAME_CHANGE_FAILURE_MESSAGE when the trimmed displayName is empty and never calls Supabase", async () => {
    const signUp = vi.fn();
    mockSupabaseAuth({ signUp });

    const result = await signUpWithPasswordAction({
      email: "user@example.com",
      password: "correcthorsebattery",
      displayName: "   ",
    });

    expect(result).toEqual({
      ok: false,
      error: DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
    });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("maps 'User already registered' upstream error to PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE", async () => {
    mockSupabaseAuth({
      signUp: vi.fn().mockResolvedValue({
        data: { session: null },
        error: { message: "User already registered" },
      }),
    });

    const result = await signUpWithPasswordAction({
      email: "user@example.com",
      password: "correcthorsebattery",
      displayName: "Alice",
    });

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE,
    });
  });

  it("returns PASSWORD_SIGN_UP_FAILURE_MESSAGE when signUp succeeds but the session is null", async () => {
    mockSupabaseAuth({
        signUp: vi
          .fn()
          .mockResolvedValue({ data: { session: null }, error: null }),
    });

    const result = await signUpWithPasswordAction({
      email: "user@example.com",
      password: "correcthorsebattery",
      displayName: "Alice",
    });

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_SIGN_UP_FAILURE_MESSAGE,
    });
  });

  it("calls FastAPI PATCH /me with the bearer token and redirects to /libraries on success", async () => {
    mockSupabaseAuth({
        signUp: vi.fn().mockResolvedValue({
          data: { session: { access_token: "the-access-token" } },
          error: null,
        }),
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    let thrown: unknown = null;
    try {
      await signUpWithPasswordAction({
        email: "user@example.com",
        password: "correcthorsebattery",
        displayName: "Alice",
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe("redirect:/libraries");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/me");
    const headers = (init as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe("Bearer the-access-token");
  });

  it("returns PASSWORD_SIGN_UP_FAILURE_MESSAGE when FastAPI PATCH /me returns 500", async () => {
    mockSupabaseAuth({
        signUp: vi.fn().mockResolvedValue({
          data: { session: { access_token: "the-access-token" } },
          error: null,
        }),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 })
    );

    const result = await signUpWithPasswordAction({
      email: "user@example.com",
      password: "correcthorsebattery",
      displayName: "Alice",
    });

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_SIGN_UP_FAILURE_MESSAGE,
    });
  });
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
