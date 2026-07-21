import { describe, expect, it } from "vitest";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { presentSearchResult } from "./search";

function viewModel(
  overrides: Partial<SearchResultRowViewModel> = {},
): SearchResultRowViewModel {
  const resourceRef = "content_chunk:c1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const href = "/media/media-1#evidence-span-1";
  return {
    key: "content_chunk-chunk-1",
    resourceRef,
    activation: {
      resourceRef,
      kind: "route",
      href,
      unresolvedReason: null,
    },
    citationTarget: resourceRef,
    paneLabelHint: "before match after",
    type: "content_chunk",
    mediaId: "b1b2c3d4-e5f6-7890-abcd-ef1234567890",
    contextRef: {
      type: "content_chunk",
      id: "c1b2c3d4-e5f6-7890-abcd-ef1234567890",
      evidenceSpanIds: [],
    },
    typeLabel: "p. 12",
    primaryText: "before match after",
    snippetSegments: [
      { text: "before ", emphasized: false },
      { text: "match", emphasized: true },
      { text: " after", emphasized: false },
    ],
    sourceMeta: "Deep Work Notes — Cal Newport",
    contributorCredits: [],
    noteBody: null,
    ...overrides,
  };
}

describe("presentSearchResult", () => {
  it("maps a search view-model to a search_result row", () => {
    const view = presentSearchResult(viewModel());
    expect(view.kind).toBe("search_result");
    expect(view.id).toBe("content_chunk-chunk-1");
    expect(view.headline.text).toBe("before match after");
  });

  it("mirrors the snippet emphasis segments onto the headline", () => {
    const vm = viewModel();
    const view = presentSearchResult(vm);
    expect(view.headline.segments).toEqual(vm.snippetSegments);
  });

  it("includes the type label as a signal", () => {
    const view = presentSearchResult(viewModel());
    expect(view.signals.map((s) => s.value)).toContain("p. 12");
  });

  it("links to the resolved activation href", () => {
    const view = presentSearchResult(viewModel());
    expect(view.primary).toMatchObject({
      kind: "link",
      href: "/media/media-1#evidence-span-1",
      viewTransition: "media-reader",
    });
  });

  it("throws when the activation has no href", () => {
    const vm = viewModel({
      activation: {
        resourceRef: "content_chunk:c1b2c3d4-e5f6-7890-abcd-ef1234567890",
        kind: "none",
        href: null,
        unresolvedReason: "unresolved",
      },
    });
    expect(() => presentSearchResult(vm)).toThrow();
  });
});
