import { describe, expect, it } from "vitest";
import {
  decodeEmailConfirmationOutcome,
  decodePasswordRecoveryOutcome,
  decodePasswordSignInOutcome,
  decodePasswordUpdateOutcome,
} from "./form-outcomes";

describe("auth form outcome wire boundary", () => {
  it.each([
    { decode: decodePasswordSignInOutcome, value: { kind: "SignedIn" } },
    {
      decode: decodePasswordSignInOutcome,
      value: { kind: "InvalidCredentials" },
    },
    { decode: decodePasswordSignInOutcome, value: { kind: "RateLimited" } },
    {
      decode: decodePasswordSignInOutcome,
      value: { kind: "ServiceUnavailable" },
    },
    { decode: decodePasswordRecoveryOutcome, value: { kind: "Requested" } },
    { decode: decodePasswordRecoveryOutcome, value: { kind: "RateLimited" } },
    {
      decode: decodePasswordRecoveryOutcome,
      value: { kind: "ServiceUnavailable" },
    },
    { decode: decodePasswordUpdateOutcome, value: { kind: "Saved" } },
    {
      decode: decodePasswordUpdateOutcome,
      value: { kind: "PolicyRejected", reasons: ["length"] },
    },
    { decode: decodePasswordUpdateOutcome, value: { kind: "SessionEnded" } },
    { decode: decodePasswordUpdateOutcome, value: { kind: "RateLimited" } },
    {
      decode: decodePasswordUpdateOutcome,
      value: { kind: "ServiceUnavailable" },
    },
  ])("decodes the exact $value.kind branch", ({ decode, value }) => {
    expect(decode(value)).toEqual(value);
  });

  it.each([
    null,
    [],
    {},
    { kind: "rateLimited" },
    { kind: "RateLimited", retryAfter: 60 },
  ])("rejects a malformed common branch: %j", (value) => {
    for (const decode of [
      decodePasswordSignInOutcome,
      decodePasswordRecoveryOutcome,
      decodePasswordUpdateOutcome,
    ]) {
      expect(() => decode(value)).toThrow(TypeError);
    }
  });

  it.each([
    { kind: "PolicyRejected" },
    { kind: "PolicyRejected", reasons: "length" },
    { kind: "PolicyRejected", reasons: [] },
    { kind: "PolicyRejected", reasons: ["characters"] },
    { kind: "PolicyRejected", reasons: ["length", "length"] },
    { kind: "PolicyRejected", reasons: ["length", 15] },
    { kind: "PolicyRejected", reasons: ["length"], message: "weak" },
  ])("rejects malformed password-policy reasons: %j", (value) => {
    expect(() => decodePasswordUpdateOutcome(value)).toThrow(TypeError);
  });

  it("requires an exact confirmation purpose and exact branch fields", () => {
    expect(
      decodeEmailConfirmationOutcome(
        { kind: "Confirmed", purpose: "invite" },
        "invite",
      ),
    ).toEqual({ kind: "Confirmed", purpose: "invite" });
    expect(
      decodeEmailConfirmationOutcome({ kind: "InvalidOrExpired" }, "recovery"),
    ).toEqual({ kind: "InvalidOrExpired" });

    for (const value of [
      { kind: "Confirmed", purpose: "recovery" },
      { kind: "Confirmed" },
      { kind: "Confirmed", purpose: "invite", token: "secret" },
      { kind: "InvalidOrExpired", purpose: "invite" },
      { kind: "RateLimited", purpose: "invite" },
      { kind: "ServiceUnavailable", retry: true },
    ]) {
      expect(() => decodeEmailConfirmationOutcome(value, "invite")).toThrow(
        TypeError,
      );
    }
  });
});
