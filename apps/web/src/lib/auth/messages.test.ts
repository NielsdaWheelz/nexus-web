import { describe, expect, it } from "vitest";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
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
});
