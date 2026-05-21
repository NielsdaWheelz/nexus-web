import { describe, expect, it } from "vitest";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
  DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE,
  EMAIL_CHANGE_FAILURE_MESSAGE,
  EMAIL_CHANGE_SUCCESS_MESSAGE,
  EMAIL_IN_USE_MESSAGE,
  KEEP_ONE_SIGN_IN_METHOD_MESSAGE,
  OAUTH_START_FAILURE_MESSAGE,
  PASSWORD_CHANGE_FAILURE_MESSAGE,
  PASSWORD_CHANGE_SUCCESS_MESSAGE,
  PASSWORD_REMOVE_FAILURE_MESSAGE,
  PASSWORD_REMOVE_SUCCESS_MESSAGE,
  PASSWORD_SET_SUCCESS_MESSAGE,
  PASSWORD_SIGN_IN_FAILURE_MESSAGE,
  PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE,
  PASSWORD_SIGN_UP_FAILURE_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  SESSION_ENDED_MESSAGE,
  toPublicAuthErrorMessage,
} from "./messages";

describe("auth public error messages", () => {
  it("maps provider cancellation codes to a safe message", () => {
    expect(toPublicAuthErrorMessage("access_denied")).toBe(
      AUTH_CALLBACK_CANCELLED_MESSAGE
    );
    expect(toPublicAuthErrorMessage("user_denied")).toBe(
      AUTH_CALLBACK_CANCELLED_MESSAGE
    );
  });

  it("preserves known safe auth messages and rejects unknown values", () => {
    expect(toPublicAuthErrorMessage(AUTH_CALLBACK_FAILURE_MESSAGE)).toBe(
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
    expect(toPublicAuthErrorMessage(AUTH_CALLBACK_CANCELLED_MESSAGE)).toBe(
      AUTH_CALLBACK_CANCELLED_MESSAGE
    );
    expect(toPublicAuthErrorMessage("custom attacker-controlled message")).toBeNull();
  });

  it("preserves the forced sign-out message the refresh route redirects with", () => {
    expect(toPublicAuthErrorMessage(SESSION_ENDED_MESSAGE)).toBe(
      SESSION_ENDED_MESSAGE
    );
  });

  it("preserves the OAuth-start failure message", () => {
    expect(toPublicAuthErrorMessage(OAUTH_START_FAILURE_MESSAGE)).toBe(
      OAUTH_START_FAILURE_MESSAGE
    );
  });

  it("round-trips password whitelisted messages", () => {
    expect(toPublicAuthErrorMessage(PASSWORD_SIGN_IN_FAILURE_MESSAGE)).toBe(
      PASSWORD_SIGN_IN_FAILURE_MESSAGE
    );
    expect(toPublicAuthErrorMessage(PASSWORD_SIGN_UP_FAILURE_MESSAGE)).toBe(
      PASSWORD_SIGN_UP_FAILURE_MESSAGE
    );
    expect(toPublicAuthErrorMessage(PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE)).toBe(
      PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE
    );
    expect(toPublicAuthErrorMessage(PASSWORD_TOO_SHORT_MESSAGE)).toBe(
      PASSWORD_TOO_SHORT_MESSAGE
    );
    expect(toPublicAuthErrorMessage(PASSWORD_CHANGE_FAILURE_MESSAGE)).toBe(
      PASSWORD_CHANGE_FAILURE_MESSAGE
    );
    expect(toPublicAuthErrorMessage(PASSWORD_REMOVE_FAILURE_MESSAGE)).toBe(
      PASSWORD_REMOVE_FAILURE_MESSAGE
    );
    expect(toPublicAuthErrorMessage(PASSWORD_CHANGE_SUCCESS_MESSAGE)).toBe(
      PASSWORD_CHANGE_SUCCESS_MESSAGE
    );
    expect(toPublicAuthErrorMessage(PASSWORD_SET_SUCCESS_MESSAGE)).toBe(
      PASSWORD_SET_SUCCESS_MESSAGE
    );
    expect(toPublicAuthErrorMessage(PASSWORD_REMOVE_SUCCESS_MESSAGE)).toBe(
      PASSWORD_REMOVE_SUCCESS_MESSAGE
    );
  });

  it("round-trips email and display-name whitelisted messages", () => {
    expect(toPublicAuthErrorMessage(EMAIL_CHANGE_FAILURE_MESSAGE)).toBe(
      EMAIL_CHANGE_FAILURE_MESSAGE
    );
    expect(toPublicAuthErrorMessage(EMAIL_IN_USE_MESSAGE)).toBe(
      EMAIL_IN_USE_MESSAGE
    );
    expect(toPublicAuthErrorMessage(EMAIL_CHANGE_SUCCESS_MESSAGE)).toBe(
      EMAIL_CHANGE_SUCCESS_MESSAGE
    );
    expect(toPublicAuthErrorMessage(DISPLAY_NAME_CHANGE_FAILURE_MESSAGE)).toBe(
      DISPLAY_NAME_CHANGE_FAILURE_MESSAGE
    );
    expect(toPublicAuthErrorMessage(DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE)).toBe(
      DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE
    );
    expect(toPublicAuthErrorMessage(KEEP_ONE_SIGN_IN_METHOD_MESSAGE)).toBe(
      KEEP_ONE_SIGN_IN_METHOD_MESSAGE
    );
  });

  it("maps Supabase invalid-credentials fragments to the sign-in failure message", () => {
    expect(toPublicAuthErrorMessage("Invalid login credentials")).toBe(
      PASSWORD_SIGN_IN_FAILURE_MESSAGE
    );
    expect(toPublicAuthErrorMessage("INVALID LOGIN CREDENTIALS")).toBe(
      PASSWORD_SIGN_IN_FAILURE_MESSAGE
    );
  });

  it("maps Supabase already-registered fragments to the email-taken message", () => {
    expect(toPublicAuthErrorMessage("User already registered")).toBe(
      PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE
    );
    expect(
      toPublicAuthErrorMessage("This email has already been registered")
    ).toBe(PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE);
  });

  it("maps Supabase weak-password fragments to the too-short message", () => {
    expect(
      toPublicAuthErrorMessage("Password should be at least 12 characters")
    ).toBe(PASSWORD_TOO_SHORT_MESSAGE);
  });

  it("treats Supabase email rate-limit messages as anonymous failures", () => {
    expect(toPublicAuthErrorMessage("Email rate limit exceeded")).toBeNull();
  });

  it("maps Supabase email-in-use fragments to the email-in-use message", () => {
    expect(
      toPublicAuthErrorMessage("Email address user@example.com is already in use")
    ).toBe(EMAIL_IN_USE_MESSAGE);
    expect(toPublicAuthErrorMessage("That email is already in use")).toBe(
      EMAIL_IN_USE_MESSAGE
    );
  });
});
