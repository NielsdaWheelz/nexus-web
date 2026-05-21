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

beforeEach(() => {
  mockCreateClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signInWithPasswordAction", () => {
  it("maps an unknown upstream error to PASSWORD_SIGN_IN_FAILURE_MESSAGE", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "unrecognized upstream failure" },
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "Invalid login credentials" },
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ data: { session: {} }, error: null }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ data: { session: {} }, error: null }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ data: { session: {} }, error: null }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ data: { session: {} }, error: null }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: { signUp },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: { signUp },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        signUp: vi.fn().mockResolvedValue({
          data: { session: null },
          error: { message: "User already registered" },
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        signUp: vi
          .fn()
          .mockResolvedValue({ data: { session: null }, error: null }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        signUp: vi.fn().mockResolvedValue({
          data: { session: { access_token: "the-access-token" } },
          error: null,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);
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
    mockCreateClient.mockResolvedValue({
      auth: {
        signUp: vi.fn().mockResolvedValue({
          data: { session: { access_token: "the-access-token" } },
          error: null,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);
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
    mockCreateClient.mockResolvedValue({
      auth: { updateUser },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await setPasswordAction({ password: "shortpw" });

    expect(result).toEqual({ ok: false, error: PASSWORD_TOO_SHORT_MESSAGE });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("maps an updateUser error to PASSWORD_CHANGE_FAILURE_MESSAGE", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
        updateUser: vi
          .fn()
          .mockResolvedValue({ data: null, error: { message: "boom" } }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await setPasswordAction({
      password: "correcthorsebattery",
    });

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_CHANGE_FAILURE_MESSAGE,
    });
  });

  it("returns { ok: true } on success", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
        updateUser: vi
          .fn()
          .mockResolvedValue({ data: {}, error: null }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

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
    mockCreateClient.mockResolvedValue({
      auth: {
        updateUser: vi
          .fn()
          .mockResolvedValue({ data: {}, error: null }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await changePasswordAction({
      password: "correcthorsebattery",
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("removePasswordAction", () => {
  it("returns PASSWORD_REMOVE_FAILURE_MESSAGE when no email identity exists", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
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
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await removePasswordAction();

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_REMOVE_FAILURE_MESSAGE,
    });
  });

  it("returns KEEP_ONE_SIGN_IN_METHOD_MESSAGE when only the email identity remains", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
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
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await removePasswordAction();

    expect(result).toEqual({
      ok: false,
      error: KEEP_ONE_SIGN_IN_METHOD_MESSAGE,
    });
  });

  it("maps an unlinkIdentity error to PASSWORD_REMOVE_FAILURE_MESSAGE", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
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
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await removePasswordAction();

    expect(result).toEqual({
      ok: false,
      error: PASSWORD_REMOVE_FAILURE_MESSAGE,
    });
  });

  it("returns { ok: true } when unlinkIdentity succeeds", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
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
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await removePasswordAction();

    expect(result).toEqual({ ok: true });
  });
});
