import { useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ReaderOverviewRuler, {
  OVERVIEW_TICK_MIN_GAP_PX,
} from "./ReaderOverviewRuler";
import type { PositionedHighlight } from "./overviewPositions";
import type { AnchoredReaderRow } from "./useAnchoredReaderProjection";

const RULER_HEIGHT = 400;
// .openSlot is a sm icon button plus var(--space-1) padding top and bottom; the
// track fills the rest. Measured against the rendered layout, not assumed.
function trackHeight(): number {
  return screen.getByRole("toolbar").getBoundingClientRect().height;
}

function highlight(
  id: string,
  overrides: Partial<AnchoredReaderRow> = {},
): AnchoredReaderRow {
  return {
    id,
    exact: `Quote ${id}`,
    color: "yellow",
    anchor: { fragment_id: "fragment-1", start_offset: 0, end_offset: 10 },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_owner: true,
    linked_conversations: [],
    linked_note_blocks: [],
    ...overrides,
  };
}

function positioned(id: string, position: number): PositionedHighlight {
  return { highlight: highlight(id), position };
}

const SCROLL_TESTID = "ruler-harness-scroll";
// The scroll container is shorter than its content, so scrollHeight exceeds
// clientHeight and the band occupies a real, scrollable fraction.
const SCROLL_VIEWPORT_PX = 350;
const SCROLL_CONTENT_PX = 1000;

function RulerHarness({
  positioned: items,
  documentSpan = { start: 0, end: 1 },
  scrollable = false,
  onActivateHighlight = () => {},
  onOpenHighlights = () => {},
}: {
  positioned: PositionedHighlight[];
  documentSpan?: { start: number; end: number };
  scrollable?: boolean;
  onActivateHighlight?: (highlightId: string) => void;
  onOpenHighlights?: () => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  return (
    <div style={{ display: "flex", height: RULER_HEIGHT }}>
      <div
        data-testid={SCROLL_TESTID}
        style={{
          overflowY: "auto",
          height: scrollable ? SCROLL_VIEWPORT_PX : undefined,
          width: 200,
        }}
      >
        <div
          ref={contentRef}
          style={{ height: scrollable ? SCROLL_CONTENT_PX : undefined }}
        />
      </div>
      <ReaderOverviewRuler
        positioned={items}
        contentRef={contentRef}
        documentSpan={documentSpan}
        onActivateHighlight={onActivateHighlight}
        onOpenHighlights={onOpenHighlights}
      />
    </div>
  );
}

describe("ReaderOverviewRuler", () => {
  it("renders a tick per positioned highlight, off-screen included", async () => {
    render(
      <RulerHarness
        positioned={[
          positioned("h1", 0.1),
          positioned("h2", 0.9),
        ]}
      />,
    );

    const first = await screen.findByTestId("reader-overview-tick-h1");
    const second = screen.getByTestId("reader-overview-tick-h2");
    expect(Number.parseFloat(first.style.top)).toBeCloseTo(
      0.1 * trackHeight(),
      0,
    );
    expect(Number.parseFloat(second.style.top)).toBeCloseTo(
      0.9 * trackHeight(),
      0,
    );
  });

  it("merges highlights closer than the minimum gap into one stacked tick", async () => {
    const gapFraction = (OVERVIEW_TICK_MIN_GAP_PX - 2) / RULER_HEIGHT;
    render(
      <RulerHarness
        positioned={[
          positioned("h1", 0.5),
          positioned("h2", 0.5 + gapFraction),
        ]}
      />,
    );

    const tick = await screen.findByTestId("reader-overview-tick-h1");
    expect(tick).toHaveAccessibleName("2 highlights");
    expect(screen.queryByTestId("reader-overview-tick-h2")).toBeNull();
  });

  it("keeps highlights farther than the minimum gap as separate ticks", async () => {
    render(
      <RulerHarness
        positioned={[
          positioned("h1", 0.2),
          positioned("h2", 0.8),
        ]}
      />,
    );

    expect(await screen.findByTestId("reader-overview-tick-h1")).toBeTruthy();
    expect(screen.getByTestId("reader-overview-tick-h2")).toBeTruthy();
  });

  it("activates the cluster's first highlight in document order on click", async () => {
    const user = userEvent.setup();
    const onActivateHighlight = vi.fn();
    const gapFraction = (OVERVIEW_TICK_MIN_GAP_PX - 2) / RULER_HEIGHT;
    render(
      <RulerHarness
        positioned={[
          positioned("h1", 0.5),
          positioned("h2", 0.5 + gapFraction),
        ]}
        onActivateHighlight={onActivateHighlight}
      />,
    );

    await user.click(await screen.findByTestId("reader-overview-tick-h1"));
    expect(onActivateHighlight).toHaveBeenCalledTimes(1);
    expect(onActivateHighlight).toHaveBeenCalledWith("h1");
  });

  it("invokes onOpenHighlights from the open button", async () => {
    const user = userEvent.setup();
    const onOpenHighlights = vi.fn();
    render(
      <RulerHarness positioned={[]} onOpenHighlights={onOpenHighlights} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Open highlights pane" }),
    );
    await waitFor(() => {
      expect(onOpenHighlights).toHaveBeenCalledTimes(1);
    });
  });

  it("derives the viewport band from documentSpan and live scroll", async () => {
    render(
      <RulerHarness
        positioned={[positioned("h1", 0.5)]}
        documentSpan={{ start: 0, end: 1 }}
        scrollable
      />,
    );

    const band = await screen.findByTestId("reader-overview-band");
    const scroller = screen.getByTestId(SCROLL_TESTID);

    // documentSpan is the full range, so the band fractions equal the
    // scroller's own visible window. Derive expectations from real layout.
    const expectBandAtScrollTop = async (scrollTop: number) => {
      scroller.scrollTop = scrollTop;
      fireEvent.scroll(scroller);
      const startFrac = scroller.scrollTop / scroller.scrollHeight;
      const endFrac =
        (scroller.scrollTop + scroller.clientHeight) / scroller.scrollHeight;
      await waitFor(() => {
        expect(Number.parseFloat(band.style.top)).toBeCloseTo(
          startFrac * trackHeight(),
          0,
        );
      });
      expect(Number.parseFloat(band.style.height)).toBeCloseTo(
        (endFrac - startFrac) * trackHeight(),
        0,
      );
    };

    await expectBandAtScrollTop(250);
    // The band keeps tracking subsequent scrolls.
    await expectBandAtScrollTop(500);
  });

  it("offsets the band into the documentSpan sub-range", async () => {
    render(
      <RulerHarness
        positioned={[positioned("h1", 0.5)]}
        documentSpan={{ start: 0.4, end: 0.8 }}
        scrollable
      />,
    );

    const band = await screen.findByTestId("reader-overview-band");
    const scroller = screen.getByTestId(SCROLL_TESTID);

    // At scrollTop 0 the band starts exactly at documentSpan.start, and its
    // height is the visible fraction scaled by the 0.4-wide span range.
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    const visibleFrac = scroller.clientHeight / scroller.scrollHeight;

    await waitFor(() => {
      expect(Number.parseFloat(band.style.top)).toBeCloseTo(
        0.4 * trackHeight(),
        0,
      );
    });
    expect(Number.parseFloat(band.style.height)).toBeCloseTo(
      visibleFrac * 0.4 * trackHeight(),
      0,
    );
  });

  it("shows a rich preview with snippet and note for a single highlight", async () => {
    render(
      <RulerHarness
        positioned={[
          {
            highlight: highlight("h1", {
              exact: "Single quote",
              prefix: "Before ",
              suffix: " after",
              linked_note_blocks: [
                {
                  note_block_id: "n1",
                  body_text: "A note about the highlight",
                },
              ],
            }),
            position: 0.5,
          },
        ]}
      />,
    );

    fireEnter(await screen.findByTestId("reader-overview-tick-h1"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Single quote");
    expect(tooltip).toHaveTextContent("Before");
    expect(tooltip).toHaveTextContent("A note about the highlight");
  });

  it("shows a compact stack with no note bodies for a 2-3 highlight cluster", async () => {
    const gapFraction = (OVERVIEW_TICK_MIN_GAP_PX - 2) / RULER_HEIGHT;
    render(
      <RulerHarness
        positioned={[
          {
            highlight: highlight("h1", { exact: "First clustered" }),
            position: 0.5,
          },
          {
            highlight: highlight("h2", {
              exact: "Second clustered",
              linked_note_blocks: [
                { note_block_id: "n2", body_text: "Hidden note" },
              ],
            }),
            position: 0.5 + gapFraction,
          },
        ]}
      />,
    );

    fireEnter(await screen.findByTestId("reader-overview-tick-h1"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("First clustered");
    expect(tooltip).toHaveTextContent("Second clustered");
    expect(tooltip).not.toHaveTextContent("Hidden note");
  });

  it("shows a placeholder for an empty-exact member of a compact cluster", async () => {
    const gapFraction = (OVERVIEW_TICK_MIN_GAP_PX - 2) / RULER_HEIGHT;
    render(
      <RulerHarness
        positioned={[
          {
            highlight: highlight("h1", { exact: "" }),
            position: 0.5,
          },
          {
            highlight: highlight("h2", { exact: "Second clustered" }),
            position: 0.5 + gapFraction,
          },
        ]}
      />,
    );

    fireEnter(await screen.findByTestId("reader-overview-tick-h1"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("No selectable text");
    expect(tooltip).toHaveTextContent("Second clustered");
  });

  it("shows only a count for a 4+ highlight cluster", async () => {
    // Clustering measures each tick against the cluster's first member, so all
    // four must fall within one min-gap window of h1 to merge into one tick.
    const step = (OVERVIEW_TICK_MIN_GAP_PX - 2) / RULER_HEIGHT / 3;
    render(
      <RulerHarness
        positioned={[
          positioned("h1", 0.5),
          positioned("h2", 0.5 + step),
          positioned("h3", 0.5 + step * 2),
          positioned("h4", 0.5 + step * 3),
        ]}
      />,
    );

    fireEnter(await screen.findByTestId("reader-overview-tick-h1"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("4 highlights");
    expect(tooltip).not.toHaveTextContent("Quote h1");
  });

  it("is a single tab stop with roving focus and Enter activation", async () => {
    const user = userEvent.setup();
    const onActivateHighlight = vi.fn();
    render(
      <RulerHarness
        positioned={[
          positioned("h1", 0.2),
          positioned("h2", 0.5),
          positioned("h3", 0.8),
        ]}
        onActivateHighlight={onActivateHighlight}
      />,
    );

    const first = await screen.findByTestId("reader-overview-tick-h1");
    const second = screen.getByTestId("reader-overview-tick-h2");
    const third = screen.getByTestId("reader-overview-tick-h3");
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);

    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);

    await user.keyboard("{End}");
    expect(third).toHaveFocus();

    await user.keyboard("{Home}");
    expect(first).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onActivateHighlight).toHaveBeenCalledWith("h1");
  });

  it("shows the focused tick's preview", async () => {
    render(
      <RulerHarness
        positioned={[
          {
            highlight: highlight("h1", { exact: "Focusable quote" }),
            position: 0.5,
          },
        ]}
      />,
    );

    (await screen.findByTestId("reader-overview-tick-h1")).focus();

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("Focusable quote");
    });
  });
});

// React synthesizes onPointerEnter from native pointerover, so the preview is
// driven through that event rather than a raw pointerenter dispatch.
function fireEnter(element: HTMLElement) {
  fireEvent.pointerEnter(element);
}
