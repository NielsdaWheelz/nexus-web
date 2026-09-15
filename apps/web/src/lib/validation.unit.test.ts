import { describe, expect, it } from "vitest";
import {
  expectCanonicalRfcUuid,
  expectCanonicalUuid,
  isCanonicalRfcUuid,
  isCanonicalUuid,
} from "./validation";

const RFC_UUID = "aaaaaaaa-1111-4111-8111-111111111111";

describe("canonical UUID validation", () => {
  it("keeps the backend-compatible lowercase grammar distinct from RFC validation", () => {
    const backendCompatibleUuid = "aaaaaaaa-1111-0111-1111-111111111111";

    expect(isCanonicalUuid(backendCompatibleUuid)).toBe(true);
    expect(expectCanonicalUuid(backendCompatibleUuid, "id")).toBe(
      backendCompatibleUuid,
    );
    expect(isCanonicalRfcUuid(backendCompatibleUuid)).toBe(false);
  });

  it("rejects uppercase and malformed values at the shared boundary", () => {
    expect(isCanonicalUuid(RFC_UUID.toUpperCase())).toBe(false);
    expect(isCanonicalUuid(`${RFC_UUID}/extra`)).toBe(false);
    expect(() => expectCanonicalUuid(RFC_UUID.toUpperCase(), "id")).toThrow(
      "id must be a canonical lowercase UUID",
    );
  });

  it("enforces a known RFC version and variant when that stricter contract applies", () => {
    expect(isCanonicalRfcUuid(RFC_UUID)).toBe(true);
    expect(expectCanonicalRfcUuid(RFC_UUID, "id")).toBe(RFC_UUID);
    expect(isCanonicalRfcUuid("aaaaaaaa-1111-0111-8111-111111111111")).toBe(
      false,
    );
    expect(isCanonicalRfcUuid("aaaaaaaa-1111-4111-7111-111111111111")).toBe(
      false,
    );
    expect(() =>
      expectCanonicalRfcUuid(RFC_UUID.toUpperCase(), "id"),
    ).toThrow("id must be a canonical lowercase RFC UUID");
  });
});
