import { describe, expect, it } from "vitest";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { decodeOptionalPublicationDate } from "@/lib/dates/publicationDate";
import { presentSearchResult } from "./search";

function viewModel(
  overrides: Partial<SearchResultRowViewModel> = {},
): SearchResultRowViewModel {
  const resourceRef = "content_chunk:c1b2c3d4-e5f6-7890-abcd-ef1234567890";
  return {
    key: "content_chunk-chunk-1",
    resourceRef,
    activation: {
      resourceRef,
      kind: "route",
      href: "/media/media-1#evidence-span-1",
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
    primaryText: "Deep Work",
    snippetSegments: [
      { text: "before ", emphasized: false },
      { text: "match", emphasized: true },
      { text: " after", emphasized: false },
    ],
    sourceMeta: "Deep Work Notes — Cal Newport",
    publicationDate: { kind: "Absent" },
    contributorCredits: [],
    noteBody: null,
    ...overrides,
  };
}

describe("presentSearchResult", () => {
  it("keeps title and emphasized result snippet in separate semantic slots", () => {
    const vm = viewModel();
    const view = presentSearchResult(vm);

    expect(view.title).toEqual({ text: "Deep Work" });
    expect(view.context).toEqual({
      kind: "Present",
      value: { kind: "Snippet", segments: vm.snippetSegments },
    });
  });

  it("links to the resolved activation href", () => {
    expect(presentSearchResult(viewModel()).primary).toMatchObject({
      kind: "link",
      href: "/media/media-1#evidence-span-1",
      viewTransition: "media-reader",
    });
  });

  it("passes the decoded publication date without duplicating it in context", () => {
    const view = presentSearchResult(
      viewModel({
        snippetSegments: [],
        sourceMeta: "Deep Work · epub",
        publicationDate: decodeOptionalPublicationDate("2025-02", "date"),
      }),
    );

    expect(view.publicationDate).toEqual({
      kind: "Present",
      value: "2025-02",
    });
    expect(view.context).toEqual({
      kind: "Present",
      value: { kind: "Text", text: "p. 12 · Deep Work · epub" },
    });
    expect(JSON.stringify(view.context)).not.toContain("2025-02");
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
