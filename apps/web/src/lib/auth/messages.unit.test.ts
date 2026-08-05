import { describe, expect, it } from "vitest";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
  EMAIL_CHANGE_FAILURE_MESSAGE,
  EMAIL_IN_USE_MESSAGE,
  OAUTH_START_FAILURE_MESSAGE,
  SESSION_ENDED_MESSAGE,
  projectEmailChangeError,
  projectOAuthCallbackError,
  readPublicAuthFeedback,
} from "./messages";

describe("auth error projections", () => {
  it.each(["access_denied", "user_denied", "consent_required"])(
    "projects the stable OAuth cancellation code %s",
    (code) => {
      expect(projectOAuthCallbackError(code)).toBe(
        AUTH_CALLBACK_CANCELLED_MESSAGE,
      );
    },
  );

  it("projects any other OAuth callback code to fixed failure copy", () => {
    expect(projectOAuthCallbackError("provider_future_code")).toBe(
      AUTH_CALLBACK_FAILURE_MESSAGE,
    );
    expect(projectOAuthCallbackError(null)).toBe(AUTH_CALLBACK_FAILURE_MESSAGE);
  });

  it.each([
    AUTH_CALLBACK_FAILURE_MESSAGE,
    AUTH_CALLBACK_CANCELLED_MESSAGE,
    OAUTH_START_FAILURE_MESSAGE,
    SESSION_ENDED_MESSAGE,
  ])("admits first-party feedback exactly: %s", (message) => {
    expect(readPublicAuthFeedback(message)).toBe(message);
  });

  it("does not interpret untrusted provider prose", () => {
    expect(readPublicAuthFeedback("Invalid login credentials")).toBeNull();
    expect(readPublicAuthFeedback("password should be at least 15")).toBeNull();
    expect(
      readPublicAuthFeedback(" Email or password is incorrect. "),
    ).toBeNull();
  });

  it("projects email conflicts by stable provider code", () => {
    expect(projectEmailChangeError("email_exists")).toBe(EMAIL_IN_USE_MESSAGE);
    expect(
      projectEmailChangeError("email_conflict_identity_not_deletable"),
    ).toBe(EMAIL_IN_USE_MESSAGE);
  });

  it.each([
    "email_address_invalid",
    "email_address_not_authorized",
    "over_email_send_rate_limit",
    "over_request_rate_limit",
    "request_timeout",
    "unexpected_failure",
    "validation_failed",
  ])("projects expected email-update code %s to fixed copy", (code) => {
    expect(projectEmailChangeError(code)).toBe(EMAIL_CHANGE_FAILURE_MESSAGE);
  });

  it("treats an unknown or missing email-update code as a defect", () => {
    expect(() => projectEmailChangeError("provider_future_code")).toThrow(
      /provider_future_code/,
    );
    expect(() => projectEmailChangeError(undefined)).toThrow(/missing/);
  });
});
