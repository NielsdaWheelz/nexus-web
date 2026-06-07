import { describe, expect, it } from "vitest";
import { disabledKinds, type SearchKind } from "./kinds";
import { applyParsedInput, emptySearchQuery, searchQueryFromInput } from "./query";
import { parseSearchInput } from "./parseSearchInput";

describe("applyParsedInput", () => {
  it("absorbs format/author operators into filters and keeps free text", () => {
    const query = searchQueryFromInput("attention format:pdf author:le-guin");
    expect(query.text).toBe("attention");
    expect(query.formats).toEqual(["pdf"]);
    expect(query.authors).toEqual(["le-guin"]);
  });

  it("narrows kinds from all (null) when a kind operator is given", () => {
    const query = searchQueryFromInput("kind:notes");
    expect(query.requestedKinds).not.toBeNull();
    expect([...(query.requestedKinds ?? [])]).toEqual(["notes"]);
  });

  it("merges new operator chips into an existing query's filters", () => {
    const base = { ...emptySearchQuery(), formats: ["pdf" as const] };
    const merged = applyParsedInput(base, parseSearchInput("epub epub format:epub"));
    expect(merged.text).toBe("epub epub");
    expect(merged.formats.sort()).toEqual(["epub", "pdf"]);
  });
});

describe("disabledKinds (implied-kind)", () => {
  it("disables non-document kinds under a format filter", () => {
    const { kinds } = disabledKinds({ hasFormatFilter: true, hasCreditFilter: false });
    const disabled = new Set<SearchKind>(kinds);
    expect(disabled.has("notes")).toBe(true);
    expect(disabled.has("web")).toBe(true);
    expect(disabled.has("documents")).toBe(false);
  });

  it("allows documents + people under an author/role filter", () => {
    const { kinds } = disabledKinds({ hasFormatFilter: false, hasCreditFilter: true });
    const disabled = new Set<SearchKind>(kinds);
    expect(disabled.has("people")).toBe(false);
    expect(disabled.has("documents")).toBe(false);
    expect(disabled.has("notes")).toBe(true);
  });

  it("disables nothing when no filter is active", () => {
    const { kinds, reason } = disabledKinds({
      hasFormatFilter: false,
      hasCreditFilter: false,
    });
    expect([...kinds]).toEqual([]);
    expect(reason).toBeNull();
  });
});
