import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CitePicker, { citableRefForRow } from "./CitePicker";
import type { SearchResultRowViewModel, SearchType } from "@/lib/search/types";

function row(
  type: SearchType,
  opts: { mediaId?: string | null; evidenceSpanIds?: string[] } = {},
): SearchResultRowViewModel {
  return {
    key: `k-${type}`,
    resourceRef: `${type}:1`,
    activation: { resourceRef: `${type}:1`, kind: "none" } as SearchResultRowViewModel["activation"],
    citationTarget: null,
    paneTitleHint: "",
    type,
    mediaId: opts.mediaId ?? null,
    contextRef: {
      type,
      id: "1",
      evidenceSpanIds: opts.evidenceSpanIds ?? [],
    },
    typeLabel: type,
    primaryText: `A ${type}`,
    snippetSegments: [],
    sourceMeta: null,
    contributorCredits: [],
    noteBody: null,
  };
}

describe("citableRefForRow", () => {
  it("cites a content-chunk passage as its evidence_span", () => {
    expect(
      citableRefForRow(row("content_chunk", { mediaId: "m1", evidenceSpanIds: ["s1"] })),
    ).toBe("evidence_span:s1");
  });

  it("falls back to media for a spanless content chunk", () => {
    expect(citableRefForRow(row("content_chunk", { mediaId: "m1" }))).toBe("media:m1");
  });

  it("cites a bare evidence_span row as itself", () => {
    expect(citableRefForRow(row("evidence_span"))).toBe("evidence_span:1");
  });

  it("cites a whole work for media/fragment/episode/video rows", () => {
    expect(citableRefForRow(row("media", { mediaId: "m2" }))).toBe("media:m2");
    expect(citableRefForRow(row("fragment", { mediaId: "m3" }))).toBe("media:m3");
    expect(citableRefForRow(row("video", { mediaId: "m4" }))).toBe("media:m4");
  });

  it("returns null for uncitable kinds", () => {
    expect(citableRefForRow(row("note_block", { mediaId: null }))).toBeNull();
    expect(citableRefForRow(row("conversation"))).toBeNull();
    expect(citableRefForRow(row("web_result"))).toBeNull();
  });
});

describe("CitePicker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mounts a focused dialog and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<CitePicker onPick={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Cite a passage" });
    expect(dialog).toBeInTheDocument();
    const input = screen.getByLabelText("Cite search");
    expect(input).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
