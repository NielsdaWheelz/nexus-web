import { describe, expect, it } from "vitest";
import { corpusMagnitude } from "./corpusMagnitude";

describe("corpusMagnitude", () => {
  it("maps 0 highlights to faint", () => {
    expect(corpusMagnitude(0)).toBe("faint");
  });

  it("maps 1–4 highlights to glimmer", () => {
    expect(corpusMagnitude(1)).toBe("glimmer");
    expect(corpusMagnitude(4)).toBe("glimmer");
  });

  it("maps 5+ highlights to bright", () => {
    expect(corpusMagnitude(5)).toBe("bright");
    expect(corpusMagnitude(42)).toBe("bright");
  });
});
