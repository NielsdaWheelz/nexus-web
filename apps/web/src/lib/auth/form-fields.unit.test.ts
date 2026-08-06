import { describe, expect, it } from "vitest";
import {
  parseEmailConfirmationForm,
  parsePasswordRecoveryForm,
  parsePasswordSignInForm,
  parsePasswordUpdateForm,
} from "./form-fields";

describe("auth form field boundary", () => {
  it("parses each one canonical string-field shape", () => {
    const signIn = new FormData();
    signIn.set("email", "buddy@example.invalid");
    signIn.set("password", "correct horse battery staple");
    signIn.set("next", "/settings/account");
    expect(parsePasswordSignInForm(signIn)).toEqual({
      email: "buddy@example.invalid",
      password: "correct horse battery staple",
      next: "/settings/account",
    });

    const recovery = new FormData();
    recovery.set("email", "buddy@example.invalid");
    expect(parsePasswordRecoveryForm(recovery)).toEqual({
      email: "buddy@example.invalid",
    });

    const update = new FormData();
    update.set("password", "correct horse battery staple");
    expect(parsePasswordUpdateForm(update)).toEqual({
      password: "correct horse battery staple",
      next: null,
    });

    const confirmation = new FormData();
    confirmation.set("token_hash", "opaque-token");
    expect(parseEmailConfirmationForm(confirmation)).toEqual({
      tokenHash: "opaque-token",
    });
  });

  it("rejects missing, duplicate, file-valued, and unknown fields", () => {
    const missing = new FormData();
    missing.set("email", "buddy@example.invalid");
    expect(parsePasswordSignInForm(missing)).toBeNull();

    const duplicate = new FormData();
    duplicate.set("email", "buddy@example.invalid");
    duplicate.append("email", "other@example.invalid");
    duplicate.set("password", "correct horse battery staple");
    expect(parsePasswordSignInForm(duplicate)).toBeNull();

    const fileValued = new FormData();
    fileValued.set("email", new File(["buddy@example.invalid"], "email.txt"));
    expect(parsePasswordRecoveryForm(fileValued)).toBeNull();

    const unknown = new FormData();
    unknown.set("token_hash", "opaque-token");
    unknown.set("type", "recovery");
    expect(parseEmailConfirmationForm(unknown)).toBeNull();

    const repeatedOptional = new FormData();
    repeatedOptional.set("password", "correct horse battery staple");
    repeatedOptional.append("next", "/lectern");
    repeatedOptional.append("next", "/settings/account");
    expect(parsePasswordUpdateForm(repeatedOptional)).toBeNull();
  });
});
