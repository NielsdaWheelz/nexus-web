import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import MessageFootnotes from "./MessageFootnotes";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";

function makeActivation(href: string): ResourceActivation {
  return {
    resourceRef: "media:media-1",
    kind: "route",
    href,
    unresolvedReason: null,
  };
}

function makeCitation(overrides: Partial<ReaderCitationData> = {}): ReaderCitationData {
  return {
    index: 1,
    preview: { title: "Source title", meta: ["Section label"] },
    activation: makeActivation("/reader/source"),
    target: null,
    ...overrides,
  };
}

describe("MessageFootnotes", () => {
  it("renders nothing when citations array is empty", () => {
    render(<MessageFootnotes citations={[]} />);
    expect(screen.queryByRole("list", { name: "Sources" })).toBeNull();
  });

  it("renders an ordered list with aria-label Sources (AC-4)", () => {
    render(
      <MessageFootnotes
        citations={[makeCitation()]}
      />,
    );
    expect(screen.getByRole("list", { name: "Sources" })).toBeInTheDocument();
  });

  it("renders citation title in the list entry (AC-4)", () => {
    render(
      <MessageFootnotes
        citations={[makeCitation({ preview: { title: "My Source" } })]}
      />,
    );
    expect(screen.getByText("My Source")).toBeInTheDocument();
  });

  it("renders section label when present", () => {
    render(
      <MessageFootnotes
        citations={[
          makeCitation({ preview: { title: "Book", meta: ["Chapter 3"] } }),
        ]}
      />,
    );
    expect(screen.getByText(/Chapter 3/)).toBeInTheDocument();
  });

  it("clicking an entry calls onCitationActivate with correct activation and target (AC-8)", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    const activation = makeActivation("/reader/source");
    render(
      <MessageFootnotes
        citations={[makeCitation({ activation })]}
        onCitationActivate={onActivate}
      />,
    );

    await user.click(screen.getByRole("link", { name: /1\. Source title/ }));

    expect(onActivate).toHaveBeenCalledWith(activation, null, expect.anything());
  });

  it("renders multiple citations as separate list items", () => {
    render(
      <MessageFootnotes
        citations={[
          makeCitation({ index: 1, preview: { title: "First" } }),
          makeCitation({ index: 2, preview: { title: "Second" } }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("renders a button when only activationTarget (no href) (AC-8)", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    const target: ReaderSourceTarget = {
      kind: "media",
      source: "message_retrieval",
      media_id: "media-1",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "frag-1",
        start_offset: 0,
        end_offset: 10,
      },
      snippet: null,
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      href: null,
      evidence_span_id: null,
    };
    const activation: ResourceActivation = {
      resourceRef: "media:media-1",
      kind: "none",
      href: null,
      unresolvedReason: "no-route",
    };

    render(
      <MessageFootnotes
        citations={[makeCitation({ activation, target })]}
        onCitationActivate={onActivate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /1\. Source title/ }));
    expect(onActivate).toHaveBeenCalledWith(
      activation,
      expect.objectContaining({ kind: "media", media_id: "media-1" }),
      expect.anything(),
    );
  });
});
