import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
  type AuthError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  requestPasswordRecoveryFlow,
  signInWithPasswordFlow,
  updatePasswordFlow,
} from "./password-flow";

function authError(code: string | undefined): AuthApiError {
  return new AuthApiError("Identical mutable provider text", 400, code);
}

const HOSTED_POLICY_DRIFT_CASES: Array<{
  reasons: ConstructorParameters<typeof AuthWeakPasswordError>[2];
}> = [
  { reasons: [] },
  { reasons: ["characters"] },
  { reasons: ["length", "characters"] },
  { reasons: ["length", "length"] },
];

function signInWithError(error: AuthError) {
  return signInWithPasswordFlow({
    supabase: {
      auth: {
        signInWithPassword: () => Promise.resolve({ data: null, error }),
      },
    },
    email: "buddy@example.invalid",
    password: "correct horse battery staple",
  });
}

function recoverWithError(error: AuthError | null) {
  return requestPasswordRecoveryFlow({
    supabase: {
      auth: {
        resetPasswordForEmail: () => Promise.resolve({ error }),
      },
    },
    email: "buddy@example.invalid",
  });
}

function updateWithError(error: AuthError) {
  return updatePasswordFlow({
    supabase: {
      auth: {
        updateUser: () => Promise.resolve({ data: null, error }),
      },
    },
    password: "correct horse battery staple",
  });
}

describe("password AuthError.code projection", () => {
  it.each([
    { code: "invalid_credentials", outcome: { kind: "InvalidCredentials" } },
    { code: "email_address_invalid", outcome: { kind: "InvalidCredentials" } },
    { code: "email_not_confirmed", outcome: { kind: "InvalidCredentials" } },
    { code: "user_banned", outcome: { kind: "InvalidCredentials" } },
    { code: "user_not_found", outcome: { kind: "InvalidCredentials" } },
    { code: "validation_failed", outcome: { kind: "InvalidCredentials" } },
    { code: "over_request_rate_limit", outcome: { kind: "RateLimited" } },
    { code: "request_timeout", outcome: { kind: "ServiceUnavailable" } },
    { code: "unexpected_failure", outcome: { kind: "ServiceUnavailable" } },
  ] as const)(
    "projects sign-in code $code without inspecting its message",
    async ({ code, outcome }) => {
      expect(await signInWithError(authError(code))).toEqual(outcome);
    },
  );

  it("defects on unmodeled and code-less sign-in errors despite familiar messages", async () => {
    await expect(
      signInWithError(
        new AuthApiError(
          "Invalid login credentials",
          400,
          "email_provider_disabled",
        ),
      ),
    ).rejects.toThrow();
    await expect(
      signInWithError(
        new AuthApiError("Invalid login credentials", 400, undefined),
      ),
    ).rejects.toThrow();
  });

  it("projects a retryable sign-in fetch failure to service unavailable", async () => {
    expect(
      await signInWithError(
        new AuthRetryableFetchError("Mutable provider text", 0),
      ),
    ).toEqual({ kind: "ServiceUnavailable" });
  });

  it("requires a provider session witness before reporting sign-in success", async () => {
    await expect(
      signInWithPasswordFlow({
        supabase: {
          auth: {
            signInWithPassword: () =>
              Promise.resolve({ data: { session: null }, error: null }),
          },
        },
        email: "buddy@example.invalid",
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow("returned no session");
  });

  it("reports sign-in success only with a provider session witness", async () => {
    const calls: object[] = [];
    const outcome = await signInWithPasswordFlow({
      supabase: {
        auth: {
          signInWithPassword: (input) => {
            calls.push(input);
            return Promise.resolve({ data: { session: {} }, error: null });
          },
        },
      },
      email: " BUDDY@example.invalid ",
      password: "correct horse battery staple",
    });

    expect(calls).toEqual([
      {
        email: "buddy@example.invalid",
        password: "correct horse battery staple",
      },
    ]);
    expect(outcome).toEqual({ kind: "SignedIn" });
  });

  it.each([
    { code: null, outcome: { kind: "Requested" } },
    { code: "email_address_invalid", outcome: { kind: "Requested" } },
    { code: "email_address_not_authorized", outcome: { kind: "Requested" } },
    { code: "over_email_send_rate_limit", outcome: { kind: "Requested" } },
    { code: "email_not_confirmed", outcome: { kind: "Requested" } },
    { code: "user_banned", outcome: { kind: "Requested" } },
    { code: "user_not_found", outcome: { kind: "Requested" } },
    { code: "validation_failed", outcome: { kind: "Requested" } },
    { code: "over_request_rate_limit", outcome: { kind: "RateLimited" } },
    { code: "request_timeout", outcome: { kind: "Requested" } },
    { code: "unexpected_failure", outcome: { kind: "Requested" } },
  ] as const)(
    "projects recovery code $code without disclosing address membership",
    async ({ code, outcome }) => {
      expect(
        await recoverWithError(code === null ? null : authError(code)),
      ).toEqual(outcome);
    },
  );

  it("keeps provider 5xx recovery failures account-private", async () => {
    expect(
      await recoverWithError(
        new AuthRetryableFetchError("Mutable provider text", 500),
      ),
    ).toEqual({ kind: "Requested" });
  });

  it("projects a no-response recovery transport failure to service unavailable", async () => {
    expect(
      await recoverWithError(
        new AuthRetryableFetchError("Mutable provider text", 0),
      ),
    ).toEqual({ kind: "ServiceUnavailable" });
  });

  it("defects on unmodeled and code-less recovery errors", async () => {
    await expect(
      recoverWithError(authError("email_provider_disabled")),
    ).rejects.toThrow();
    await expect(recoverWithError(authError(undefined))).rejects.toThrow();
  });

  it.each([
    "session_not_found",
    "session_expired",
    "user_banned",
    "user_not_found",
  ] as const)("projects update code %s to an ended session", async (code) => {
    expect(await updateWithError(authError(code))).toEqual({
      kind: "SessionEnded",
    });
  });

  it("projects the SDK's code-less missing-session type to an ended session", async () => {
    expect(await updateWithError(new AuthSessionMissingError())).toEqual({
      kind: "SessionEnded",
    });
  });

  it("projects update rate limits and converges a same-password retry", async () => {
    expect(await updateWithError(authError("over_request_rate_limit"))).toEqual(
      { kind: "RateLimited" },
    );
    expect(await updateWithError(authError("same_password"))).toEqual({
      kind: "Saved",
    });
    expect(await updateWithError(authError("conflict"))).toEqual({
      kind: "ServiceUnavailable",
    });
  });

  it("normalizes the configured weak-password reason at the provider boundary", async () => {
    expect(
      await updateWithError(
        new AuthWeakPasswordError("Mutable provider text", 400, ["length"]),
      ),
    ).toEqual({ kind: "PolicyRejected", reasons: ["length"] });
  });

  it.each(HOSTED_POLICY_DRIFT_CASES)(
    "defects when hosted weak-password reasons drift: $reasons",
    async ({ reasons }) => {
      await expect(
        updateWithError(
          new AuthWeakPasswordError("Mutable provider text", 400, reasons),
        ),
      ).rejects.toThrow("password policy reasons");
    },
  );

  it("enforces the 15-character policy before password mutation", async () => {
    const outcome = await updatePasswordFlow({
      supabase: {
        auth: {
          updateUser: () => {
            throw new Error("weak password reached the provider");
          },
        },
      },
      password: "x".repeat(14),
    });

    expect(outcome).toEqual({ kind: "PolicyRejected", reasons: ["length"] });
  });

  it("accepts a 15-character password at the local policy boundary", async () => {
    const outcome = await updatePasswordFlow({
      supabase: {
        auth: {
          updateUser: () =>
            Promise.resolve({ data: { user: { id: "user-1" } }, error: null }),
        },
      },
      password: "x".repeat(15),
    });

    expect(outcome).toEqual({ kind: "Saved" });
  });

  it("requires a provider user witness before reporting password saved", async () => {
    for (const user of [null, {}, { id: "" }]) {
      await expect(
        updatePasswordFlow({
          supabase: {
            auth: {
              updateUser: () =>
                Promise.resolve({ data: { user }, error: null }),
            },
          },
          password: "x".repeat(15),
        }),
      ).rejects.toThrow("returned no user");
    }
  });

  it("projects transient update failures to service unavailable", async () => {
    for (const error of [
      authError("request_timeout"),
      authError("unexpected_failure"),
      new AuthRetryableFetchError("Mutable provider text", 0),
    ]) {
      expect(await updateWithError(error)).toEqual({
        kind: "ServiceUnavailable",
      });
    }
  });

  it("defects on unmodeled and code-less update errors", async () => {
    await expect(
      updateWithError(authError("email_provider_disabled")),
    ).rejects.toThrow();
    await expect(updateWithError(authError(undefined))).rejects.toThrow();
  });
});
