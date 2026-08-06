import {
  AuthApiError,
  AuthRetryableFetchError,
  type AuthError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  confirmEmail,
  parseEmailConfirmationToken,
  type EmailLinkKind,
} from "./email-confirmation";

function confirmationWithError(
  purpose: EmailLinkKind,
  error: AuthError | null,
) {
  const token = parseEmailConfirmationToken({ tokenHash: "opaque-token" });
  if (token.kind !== "Valid") {
    throw new Error("Static confirmation token fixture was rejected");
  }
  return confirmEmail({
    supabase: {
      auth: {
        verifyOtp: () =>
          Promise.resolve({
            data: { session: error ? null : {} },
            error,
          }),
      },
    },
    purpose,
    tokenHash: token.tokenHash,
  });
}

describe("email confirmation boundary", () => {
  it("accepts one exact non-empty opaque token without normalizing it", () => {
    const tokenHash = "Fixture-token_hash.123";

    expect(parseEmailConfirmationToken({ tokenHash })).toEqual({
      kind: "Valid",
      tokenHash,
    });
  });

  it.each([
    { name: "missing", tokenHash: undefined },
    { name: "null", tokenHash: null },
    { name: "empty", tokenHash: "" },
    { name: "blank", tokenHash: " \t\n" },
    { name: "repeated", tokenHash: ["token-one", "token-two"] },
    { name: "non-string", tokenHash: { value: "token" } },
  ])("rejects a $name token value", ({ tokenHash }) => {
    expect(parseEmailConfirmationToken({ tokenHash })).toEqual({
      kind: "Invalid",
    });
  });

  it.each(["invite", "recovery"] as const)(
    "preserves the confirmed %s purpose",
    async (purpose) => {
      expect(await confirmationWithError(purpose, null)).toEqual({
        kind: "Confirmed",
        purpose,
      });
    },
  );

  it.each(["invite", "recovery"] as const)(
    "binds the opaque token to the fixed %s provider operation",
    async (purpose) => {
      const parsed = parseEmailConfirmationToken({ tokenHash: "opaque-token" });
      expect(parsed.kind).toBe("Valid");
      if (parsed.kind !== "Valid") return;

      const calls: object[] = [];
      const outcome = await confirmEmail({
        supabase: {
          auth: {
            verifyOtp: (input) => {
              calls.push(input);
              return Promise.resolve({ data: { session: {} }, error: null });
            },
          },
        },
        purpose,
        tokenHash: parsed.tokenHash,
      });

      expect(calls).toEqual([{ token_hash: "opaque-token", type: purpose }]);
      expect(outcome).toEqual({ kind: "Confirmed", purpose });
    },
  );

  it("defects when provider success fails to establish a session", async () => {
    const parsed = parseEmailConfirmationToken({ tokenHash: "opaque-token" });
    expect(parsed.kind).toBe("Valid");
    if (parsed.kind !== "Valid") return;

    await expect(
      confirmEmail({
        supabase: {
          auth: {
            verifyOtp: () =>
              Promise.resolve({ data: { session: null }, error: null }),
          },
        },
        purpose: "invite",
        tokenHash: parsed.tokenHash,
      }),
    ).rejects.toThrow("returned no session");
  });

  it.each([
    { purpose: "invite", code: "invite_not_found" },
    { purpose: "invite", code: "otp_expired" },
    { purpose: "invite", code: "user_banned" },
    { purpose: "invite", code: "user_not_found" },
    { purpose: "invite", code: "validation_failed" },
    { purpose: "recovery", code: "otp_expired" },
    { purpose: "recovery", code: "user_banned" },
    { purpose: "recovery", code: "user_not_found" },
    { purpose: "recovery", code: "validation_failed" },
  ] as const)(
    "projects $purpose/$code to invalid-or-expired guidance",
    async ({ purpose, code }) => {
      expect(
        await confirmationWithError(
          purpose,
          new AuthApiError("Mutable provider text", 400, code),
        ),
        `${purpose}/${code} lost invalid-or-expired confirmation guidance`,
      ).toEqual({ kind: "InvalidOrExpired" });
    },
  );

  it("projects confirmation rate limits and transient failures", async () => {
    expect(
      await confirmationWithError(
        "invite",
        new AuthApiError(
          "Mutable provider text",
          400,
          "over_request_rate_limit",
        ),
      ),
    ).toEqual({ kind: "RateLimited" });

    for (const error of [
      new AuthApiError("Mutable provider text", 400, "request_timeout"),
      new AuthApiError("Mutable provider text", 400, "unexpected_failure"),
      new AuthRetryableFetchError("Mutable provider text", 0),
    ]) {
      expect(await confirmationWithError("recovery", error)).toEqual({
        kind: "ServiceUnavailable",
      });
    }
  });

  it("defects on purpose-incompatible, unknown, and code-less provider errors", async () => {
    for (const input of [
      {
        purpose: "recovery" as const,
        error: new AuthApiError("Invite expired", 400, "invite_not_found"),
      },
      {
        purpose: "invite" as const,
        error: new AuthApiError("OTP expired", 400, "email_provider_disabled"),
      },
      {
        purpose: "invite" as const,
        error: new AuthApiError("OTP expired", 400, undefined),
      },
    ]) {
      await expect(
        confirmationWithError(input.purpose, input.error),
      ).rejects.toThrow();
    }
  });
});
