import { describe, expect, it } from "vitest";
import {
  browseHref,
  decodeBrowseQuery,
  normalizeBrowseDraft,
  withBrowseKind,
  withBrowseSource,
  type BrowseQuery,
} from "./query";

function decode(search: string) {
  return decodeBrowseQuery(new URLSearchParams(search));
}

describe("Browse URL query", () => {
  it("decodes the empty landing without retrieval state", () => {
    expect(decode("")).toEqual({
      kind: "Valid",
      query: {
        text: "",
        kind: "All",
        source: null,
        sort: "Relevance",
      },
    });
  });

  it("accepts only applicable canonical facet tuples", () => {
    expect(
      decode("q=writers&kind=Video&source=YouTube&sort=Newest"),
    ).toEqual({
      kind: "Valid",
      query: {
        text: "writers",
        kind: "Video",
        source: "YouTube",
        sort: "Newest",
      },
    });
    for (const search of [
      "kind=All",
      "kind=Podcast&source=Nexus",
      "kind=Video&sort=Newest",
      "kind=Video&source=Nexus&sort=Newest",
      "kind=Podcast&sort=Relevance",
      "kind=Unknown",
      "source=Brave",
      "extra=1",
    ]) {
      expect(decode(search), search).toEqual({ kind: "Invalid" });
    }
  });

  it("rejects duplicate or noncanonical external q state", () => {
    for (const search of [
      "q=x&q=y",
      "q=",
      "q=%20x",
      "q=x%20",
      `q=${encodeURIComponent("e\u0301")}`,
      `q=${encodeURIComponent("x\u0007")}`,
      `q=${"x".repeat(201)}`,
    ]) {
      expect(decode(search), search).toEqual({ kind: "Invalid" });
    }
  });

  it("normalizes human draft once and emits default-omitting URLs", () => {
    expect(normalizeBrowseDraft("  e\u0301lan  ")).toBe("élan");
    expect(
      browseHref({
        text: "élan",
        kind: "Video",
        source: "YouTube",
        sort: "Relevance",
      }),
    ).toBe("/browse?q=%C3%A9lan&kind=Video&source=YouTube");
  });

  it("rewrites dependent facets when kind or source changes", () => {
    const current: BrowseQuery = {
      text: "x",
      kind: "Video",
      source: "YouTube",
      sort: "Newest",
    };
    expect(withBrowseKind(current, "Podcast")).toEqual({
      text: "x",
      kind: "Podcast",
      source: null,
      sort: "Relevance",
    });
    expect(withBrowseSource(current, "Nexus")).toEqual({
      text: "x",
      kind: "Video",
      source: "Nexus",
      sort: "Relevance",
    });
  });
});
