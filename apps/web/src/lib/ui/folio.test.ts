import { describe, expect, it } from "vitest";
import { formatFolio } from "@/lib/ui/folio";

describe("formatFolio", () => {
  it("formats a singular count without pluralizing", () => {
    expect(formatFolio({ kind: "count", value: 1, unit: "library" })).toBe(
      "1 library",
    );
  });

  it("pluralizes counts, including -y → -ies and sibilant → -es", () => {
    expect(formatFolio({ kind: "count", value: 37, unit: "source" })).toBe(
      "37 sources",
    );
    expect(formatFolio({ kind: "count", value: 6, unit: "library" })).toBe(
      "6 libraries",
    );
    expect(formatFolio({ kind: "count", value: 214, unit: "entry" })).toBe(
      "214 entries",
    );
    expect(formatFolio({ kind: "count", value: 2, unit: "class" })).toBe(
      "2 classes",
    );
  });

  it("groups large counts with the viewer's thousands separator", () => {
    expect(formatFolio({ kind: "count", value: 1200, unit: "result" })).toBe(
      `${(1200).toLocaleString()} results`,
    );
  });

  it("formats a date-only ISO as a short weekday+day+month in local time", () => {
    const out = formatFolio({ kind: "date", iso: "2026-07-07" });
    expect(out).not.toBeNull();
    expect(out).toContain("Jul");
    expect(out).toContain("7");
  });

  it("returns null for an unparseable date", () => {
    expect(formatFolio({ kind: "date", iso: "not-a-date" })).toBeNull();
  });

  it("passes a title through untruncated", () => {
    expect(
      formatFolio({ kind: "title", value: "Designing Data-Intensive Applications" }),
    ).toBe("Designing Data-Intensive Applications");
  });

  it("renders nothing for a none folio", () => {
    expect(formatFolio({ kind: "none" })).toBeNull();
  });
});
