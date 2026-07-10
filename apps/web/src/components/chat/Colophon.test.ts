import { describe, expect, it } from "vitest";
import {
  formatColophonCost,
  formatColophonModel,
  formatColophonSources,
  formatColophonTokens,
} from "./Colophon";

describe("formatColophonModel", () => {
  it("uppercases the model name", () => {
    expect(formatColophonModel("claude-sonnet-4-6")).toBe("CLAUDE-SONNET-4-6");
  });

  it("is idempotent on already-uppercased input", () => {
    expect(formatColophonModel("CLAUDE-SONNET-4-6")).toBe("CLAUDE-SONNET-4-6");
  });

  it("preserves digits and hyphens", () => {
    expect(formatColophonModel("claude-3-5-sonnet-20241022")).toBe(
      "CLAUDE-3-5-SONNET-20241022",
    );
  });

  it("returns empty string for null", () => {
    expect(formatColophonModel(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(formatColophonModel("")).toBe("");
  });
});

describe("formatColophonTokens", () => {
  it("returns empty string when both null (segment omitted)", () => {
    expect(formatColophonTokens(null, null)).toBe("");
  });

  it("formats 0–999 as plain numbers", () => {
    expect(formatColophonTokens(0, 0)).toBe("0 IN / 0 OUT");
    expect(formatColophonTokens(500, 200)).toBe("500 IN / 200 OUT");
    expect(formatColophonTokens(999, 1)).toBe("999 IN / 1 OUT");
  });

  it("formats 1000 as 1.0K", () => {
    expect(formatColophonTokens(1000, null)).toBe("1.0K IN / — OUT");
  });

  it("formats 3200 as 3.2K", () => {
    expect(formatColophonTokens(3200, 1100)).toBe("3.2K IN / 1.1K OUT");
  });

  it("renders — for a null value when the other is non-null", () => {
    expect(formatColophonTokens(null, 500)).toBe("— IN / 500 OUT");
    expect(formatColophonTokens(2000, null)).toBe("2.0K IN / — OUT");
  });
});

describe("formatColophonCost", () => {
  it("returns empty string for null (segment omitted)", () => {
    expect(formatColophonCost(null)).toBe("");
  });

  it("formats 14123 micros as $0.014", () => {
    expect(formatColophonCost(14_123)).toBe("$0.014");
  });

  it("formats 1_000_000 micros as $1.000", () => {
    expect(formatColophonCost(1_000_000)).toBe("$1.000");
  });

  it("formats 0 micros as $0.000", () => {
    expect(formatColophonCost(0)).toBe("$0.000");
  });
});

describe("Colophon segment join", () => {
  it("joins non-empty segments with · delimiter", () => {
    // Verify the join by checking that model + tokens + cost produce ·-delimited output.
    const model = formatColophonModel("claude-sonnet-4-6");
    const tokens = formatColophonTokens(3200, 1100);
    const cost = formatColophonCost(14_123);
    const segments = [model, tokens, cost].filter(Boolean);
    expect(segments.join(" · ")).toBe(
      "CLAUDE-SONNET-4-6 · 3.2K IN / 1.1K OUT · $0.014",
    );
  });
});

describe("formatColophonSources", () => {
  it("returns empty string for 0 (segment omitted)", () => {
    expect(formatColophonSources(0)).toBe("");
  });

  it("singular: 1 SOURCE", () => {
    expect(formatColophonSources(1)).toBe("1 SOURCE");
  });

  it("plural: 2 SOURCES", () => {
    expect(formatColophonSources(2)).toBe("2 SOURCES");
  });

  it("plural: 4 SOURCES", () => {
    expect(formatColophonSources(4)).toBe("4 SOURCES");
  });
});
