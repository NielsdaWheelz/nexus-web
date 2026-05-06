import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ReaderGutter from "./ReaderGutter";
import {
  READER_PULSE_HIGHLIGHT,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";
import type { PdfHighlightOut } from "@/components/PdfReader";

function pdfHighlight(overrides: { id: string; page: number }): PdfHighlightOut {
  return {
    id: overrides.id,
    anchor: {
      type: "pdf_page_geometry",
      media_id: "media-1",
      page_number: overrides.page,
      quads: [
        { x1: 0, y1: 100, x2: 100, y2: 100, x3: 100, y3: 120, x4: 0, y4: 120 },
      ],
    },
    color: "yellow",
    exact: `Quote ${overrides.id}`,
    prefix: "",
    suffix: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    author_user_id: "user-1",
    is_owner: true,
    linked_conversations: [],
    linked_note_blocks: [],
  };
}

describe("ReaderGutter", () => {
  it("renders one tick per PDF highlight at the correct vertical position", () => {
    render(
      <ReaderGutter
        mediaId="media-1"
        mediaKind="pdf"
        pdfHighlights={[
          pdfHighlight({ id: "h1", page: 1 }),
          pdfHighlight({ id: "h2", page: 5 }),
        ]}
        totalPages={10}
        scrollContainer={null}
        onExpand={() => {}}
      />,
    );
    expect(screen.getByTestId("reader-gutter-tick-h1")).toBeTruthy();
    expect(screen.getByTestId("reader-gutter-tick-h2")).toBeTruthy();
  });

  it("dispatches the reader-pulse event when a tick is clicked", async () => {
    const user = userEvent.setup();
    const events: ReaderPulseTarget[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<ReaderPulseTarget>).detail);
    };
    window.addEventListener(READER_PULSE_HIGHLIGHT, handler);

    render(
      <ReaderGutter
        mediaId="media-1"
        mediaKind="pdf"
        pdfHighlights={[pdfHighlight({ id: "h1", page: 1 })]}
        totalPages={10}
        scrollContainer={null}
        onExpand={() => {}}
      />,
    );
    await user.click(screen.getByTestId("reader-gutter-tick-h1"));
    expect(events).toHaveLength(1);
    expect(events[0]?.mediaId).toBe("media-1");
    expect(events[0]?.snippet).toBe("Quote h1");

    window.removeEventListener(READER_PULSE_HIGHLIGHT, handler);
  });

  it("invokes onExpand when the expand affordance is activated", async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    render(
      <ReaderGutter
        mediaId="media-1"
        mediaKind="pdf"
        pdfHighlights={[]}
        totalPages={10}
        scrollContainer={null}
        onExpand={onExpand}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Open highlights inspector" }),
    );
    await waitFor(() => {
      expect(onExpand).toHaveBeenCalledTimes(1);
    });
  });
});
