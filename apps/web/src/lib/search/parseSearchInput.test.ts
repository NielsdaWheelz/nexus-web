import { describe, expect, it } from "vitest";
import { parseSearchInput } from "./parseSearchInput";

describe("parseSearchInput", () => {
  it("treats plain words as free text", () => {
    const { text, chips } = parseSearchInput("deep work focus");
    expect(text).toBe("deep work focus");
    expect(chips).toEqual([]);
  });

  it("extracts format/author/role/kind/in operators as chips", () => {
    const { text, chips } = parseSearchInput(
      "attention format:pdf author:le-guin role:translator kind:notes in:library:11111111-1111-4111-8111-111111111111",
    );
    expect(text).toBe("attention");
    expect(chips).toEqual([
      { dim: "format", value: "pdf" },
      { dim: "author", value: "le-guin" },
      { dim: "role", value: "translator" },
      { dim: "kind", value: "notes" },
      {
        dim: "scope",
        value: "library:11111111-1111-4111-8111-111111111111",
      },
    ]);
  });

  it("maps kind and format aliases to canonical values", () => {
    expect(parseSearchInput("kind:docs").chips).toEqual([
      { dim: "kind", value: "documents" },
    ]);
    expect(parseSearchInput("kind:chat").chips).toEqual([
      { dim: "kind", value: "conversations" },
    ]);
  });

  it("keeps malformed or unknown operators as free text", () => {
    expect(parseSearchInput("format:nonsense").text).toBe("format:nonsense");
    expect(parseSearchInput("format:nonsense").chips).toEqual([]);
    expect(parseSearchInput("kind:unknownkind").chips).toEqual([]);
    // role not in the taxonomy stays free text
    expect(parseSearchInput("role:wizard").chips).toEqual([]);
    expect(parseSearchInput("role:wizard").text).toBe("role:wizard");
  });

  it("honors quoted operator values", () => {
    const { text, chips } = parseSearchInput('attention author:"Ursula Le Guin"');
    expect(text).toBe("attention");
    expect(chips).toEqual([{ dim: "author", value: "Ursula Le Guin" }]);
  });

  it("dedupes repeated chips", () => {
    expect(parseSearchInput("format:pdf format:pdf").chips).toEqual([
      { dim: "format", value: "pdf" },
    ]);
  });
});
