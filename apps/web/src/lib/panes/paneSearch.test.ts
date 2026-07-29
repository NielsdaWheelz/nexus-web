import { describe, expect, it, vi } from "vitest";
import {
  PANE_SEARCH_QUERY_MAX_CODEPOINTS,
  arePaneSearchPublicationsEqual,
  createPaneFindResultKey,
  createPaneFindSourceKey,
  truncatePaneSearchQuery,
  type PaneSearchPublication,
} from "./paneSearch";

describe("Pane Search contract", () => {
  it("caps shared queries by Unicode codepoint rather than UTF-16 unit", () => {
    const query = `${"a".repeat(PANE_SEARCH_QUERY_MAX_CODEPOINTS - 1)}😀z`;
    const truncated = truncatePaneSearchQuery(query);

    expect(Array.from(truncated)).toHaveLength(
      PANE_SEARCH_QUERY_MAX_CODEPOINTS,
    );
    expect(truncated.endsWith("😀")).toBe(true);
  });

  it("canonically encodes source and result identities", () => {
    expect(createPaneFindSourceKey({ revision: 2, mediaId: "m-1" })).toBe(
      createPaneFindSourceKey({ mediaId: "m-1", revision: 2 }),
    );
    expect(
      createPaneFindResultKey({
        source: { mediaId: "m-1", revision: 2 },
        locator: { fragmentId: "a:b", start: 3 },
      }),
    ).not.toBe(
      createPaneFindResultKey({
        source: { mediaId: "m-1", revision: 2 },
        locator: { fragmentId: "a", start: 3 },
      }),
    );
    expect(createPaneFindSourceKey({ ä: 1, z: 2 })).toBe('{"z":2,"ä":1}');
  });

  it("rejects non-canonical numeric identities", () => {
    expect(() => createPaneFindSourceKey({ revision: Number.NaN })).toThrow(
      "canonical finite numbers",
    );
    expect(() => createPaneFindSourceKey({ revision: -0 })).toThrow(
      "canonical finite numbers",
    );
  });

  it("compares the owned publication values", () => {
    const onQueryChange = vi.fn();
    const onDismiss = vi.fn();
    const publication: PaneSearchPublication = {
      kind: "FilterRows",
      query: "needle",
      inputLabel: "Search this list",
      placeholder: "Search",
      onQueryChange,
      onDismiss,
    };
    expect(
      arePaneSearchPublicationsEqual(publication, { ...publication }),
    ).toBe(true);
    expect(
      arePaneSearchPublicationsEqual(publication, {
        ...publication,
        query: "other",
      }),
    ).toBe(false);
  });
});
