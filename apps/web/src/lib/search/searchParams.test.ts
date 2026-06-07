import { describe, expect, it } from "vitest";
import { SEARCH_KINDS, type SearchKind } from "./kinds";
import { emptySearchQuery } from "./query";
import { searchQueryFromParams, searchQueryToParams } from "./searchParams";

function paramsOf(query: Parameters<typeof searchQueryToParams>[0]): string {
  return searchQueryToParams(query).toString();
}

describe("searchParams round-trip", () => {
  it("omits the kinds param when requestedKinds is null (⇒ all)", () => {
    const params = searchQueryToParams({ ...emptySearchQuery(), text: "x" });
    expect(params.has("kinds")).toBe(false);
    const back = searchQueryFromParams(params);
    expect(back.requestedKinds).toBeNull();
  });

  it("emits an empty kinds param for an explicitly-empty set (⇒ none)", () => {
    const params = searchQueryToParams({
      ...emptySearchQuery(),
      text: "x",
      requestedKinds: new Set<SearchKind>(),
    });
    expect(params.get("kinds")).toBe("");
    const back = searchQueryFromParams(params);
    expect(back.requestedKinds).not.toBeNull();
    expect(back.requestedKinds?.size).toBe(0);
  });

  it("round-trips a kind subset, formats, authors, roles, and scope", () => {
    const query = {
      text: "attention is all you need",
      requestedKinds: new Set<SearchKind>(["documents", "people"]),
      formats: ["pdf" as const],
      authors: ["le-guin"],
      roles: ["translator"],
      scope: "library:lib-1",
    };
    const back = searchQueryFromParams(searchQueryToParams(query));
    expect(back.text).toBe(query.text);
    expect([...(back.requestedKinds ?? [])].sort()).toEqual(["documents", "people"]);
    expect(back.formats).toEqual(["pdf"]);
    expect(back.authors).toEqual(["le-guin"]);
    expect(back.roles).toEqual(["translator"]);
    expect(back.scope).toBe("library:lib-1");
  });

  it("serializes a full kind set in canonical order", () => {
    const params = paramsOf({
      ...emptySearchQuery(),
      requestedKinds: new Set<SearchKind>(SEARCH_KINDS),
    });
    expect(params).toContain(`kinds=${SEARCH_KINDS.join("%2C")}`);
  });
});
