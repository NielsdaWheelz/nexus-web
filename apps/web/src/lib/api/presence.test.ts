import { describe, expect, it } from "vitest";
import { absent, decodePresence, present, presenceValueOr, type Presence } from "./presence";

const decodeNumber = (value: unknown): number => {
  if (typeof value !== "number") {
    throw new Error(`Invalid number: ${JSON.stringify(value)}`);
  }
  return value;
};

describe("decodePresence", () => {
  describe("acceptance", () => {
    it("decodes the Present variant", () => {
      const result = decodePresence({ kind: "Present", value: 5 }, decodeNumber);
      expect(result).toEqual({ kind: "Present", value: 5 });
    });

    it("decodes the Absent variant", () => {
      const result = decodePresence({ kind: "Absent" }, decodeNumber);
      expect(result).toEqual({ kind: "Absent" });
    });

    it("delegates inner value decoding to decodeValue", () => {
      const result = decodePresence({ kind: "Present", value: "42" }, (value) => {
        if (typeof value !== "string") throw new Error("expected string");
        return Number.parseInt(value, 10);
      });
      expect(result).toEqual({ kind: "Present", value: 42 });
    });
  });

  describe("rejection", () => {
    it("rejects null", () => {
      expect(() => decodePresence(null, decodeNumber)).toThrow();
    });

    it("rejects undefined", () => {
      expect(() => decodePresence(undefined, decodeNumber)).toThrow();
    });

    it("rejects non-object primitives", () => {
      expect(() => decodePresence("Absent", decodeNumber)).toThrow();
      expect(() => decodePresence(5, decodeNumber)).toThrow();
      expect(() => decodePresence(true, decodeNumber)).toThrow();
    });

    it("rejects arrays", () => {
      expect(() => decodePresence([], decodeNumber)).toThrow();
    });

    it("rejects lowercase kind casing", () => {
      expect(() => decodePresence({ kind: "absent" }, decodeNumber)).toThrow();
      expect(() => decodePresence({ kind: "present", value: 1 }, decodeNumber)).toThrow();
    });

    it("rejects an unknown kind", () => {
      expect(() => decodePresence({ kind: "Unknown" }, decodeNumber)).toThrow();
    });

    it("rejects a missing kind", () => {
      expect(() => decodePresence({ value: 1 }, decodeNumber)).toThrow();
    });

    it("rejects Present missing value", () => {
      expect(() => decodePresence({ kind: "Present" }, decodeNumber)).toThrow();
    });

    it("rejects Absent with an extra value key", () => {
      expect(() => decodePresence({ kind: "Absent", value: 1 }, decodeNumber)).toThrow();
    });

    it("rejects Present with extra unknown keys", () => {
      expect(() =>
        decodePresence({ kind: "Present", value: 1, extra: true }, decodeNumber),
      ).toThrow();
    });

    it("rejects Absent with extra unknown keys", () => {
      expect(() => decodePresence({ kind: "Absent", extra: true }, decodeNumber)).toThrow();
    });

    it("propagates decodeValue rejection of the inner value", () => {
      expect(() =>
        decodePresence({ kind: "Present", value: "not a number" }, decodeNumber),
      ).toThrow();
    });
  });
});

describe("present / absent", () => {
  it("present wraps a value", () => {
    const value: Presence<number> = present(5);
    expect(value).toEqual({ kind: "Present", value: 5 });
  });

  it("absent carries no value", () => {
    const value: Presence<number> = absent();
    expect(value).toEqual({ kind: "Absent" });
  });
});

describe("presenceValueOr", () => {
  it("returns the value when Present", () => {
    expect(presenceValueOr(present(5), 0)).toBe(5);
  });

  it("returns the fallback when Absent", () => {
    expect(presenceValueOr(absent<number>(), 0)).toBe(0);
  });
});
