import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import SecondaryRail from "@/components/secondaryRail/SecondaryRail";
import ReaderGutter from "./ReaderGutter";
import {
  READER_PULSE_HIGHLIGHT,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";
import type { AnchoredHighlightRow } from "./useAnchoredHighlightProjection";

function highlight(id: string, startOffset: number): AnchoredHighlightRow {
  return {
    id,
    exact: `Quote ${id}`,
    color: "yellow",
    anchor: {
      fragment_id: "fragment-1",
      start_offset: startOffset,
      end_offset: startOffset + 10,
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_owner: true,
    linked_conversations: [],
    linked_note_blocks: [],
  };
}

function ReaderGutterHarness({
  children,
  highlights,
  onExpand = () => {},
  onFocusHighlight = () => {},
  measureKey,
}: {
  children: ReactNode;
  highlights: AnchoredHighlightRow[];
  onExpand?: () => void;
  onFocusHighlight?: (highlightId: string) => void;
  measureKey?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 36px", height: 180 }}>
      <div
        data-testid="reader-scroll"
        style={{ height: 180, overflowY: "auto" }}
      >
        <div ref={contentRef} style={{ position: "relative", height: 520 }}>
          {children}
        </div>
      </div>
      <ReaderGutter
        mediaId="media-1"
        mediaKind="web"
        highlights={highlights}
        contentRef={contentRef}
        measureKey={measureKey ?? highlights.map((item) => item.id).join("|")}
        onFocusHighlight={onFocusHighlight}
        onExpand={onExpand}
      />
    </div>
  );
}

function DesktopSecondaryRailHarness({
  highlights,
}: {
  highlights: AnchoredHighlightRow[];
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div style={{ display: "flex", height: 180 }}>
      <div
        data-testid="reader-scroll"
        style={{ height: 180, overflowY: "auto", flex: "1 1 auto" }}
      >
        <div ref={contentRef} style={{ position: "relative", height: 520 }}>
          <span
            data-active-highlight-ids="h1"
            style={{ position: "absolute", top: 48, left: 0, width: 120, height: 24 }}
          >
            First target
          </span>
        </div>
      </div>
      <SecondaryRail
        ariaLabel="Reader tools"
        expanded={false}
        onExpandedChange={() => {}}
        collapsed={
          <ReaderGutter
            mediaId="media-1"
            mediaKind="web"
            highlights={highlights}
            contentRef={contentRef}
            measureKey={highlights.map((item) => item.id).join("|")}
            onFocusHighlight={() => {}}
            onExpand={() => {}}
          />
        }
      >
        <div />
      </SecondaryRail>
    </div>
  );
}

describe("ReaderGutter", () => {
  it("fills the collapsed desktop secondary rail height", async () => {
    render(<DesktopSecondaryRailHarness highlights={[highlight("h1", 10)]} />);

    const marker = await screen.findByTestId("reader-gutter-marker-h1");
    const gutter = screen.getByTestId("reader-gutter");
    expect(gutter.getBoundingClientRect().height).toBeCloseTo(180, 0);
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(48, 0);
  });

  it("keeps marker fill visible under border-box sizing", async () => {
    render(
      <ReaderGutterHarness highlights={[highlight("h1", 10)]}>
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 72, left: 0, width: 120, height: 24 }}
        >
          Target
        </span>
      </ReaderGutterHarness>,
    );

    const marker = await screen.findByTestId("reader-gutter-marker-h1");
    const markerStyle = window.getComputedStyle(marker);
    const contentHeight =
      Number.parseFloat(markerStyle.height) -
      Number.parseFloat(markerStyle.paddingTop) -
      Number.parseFloat(markerStyle.paddingBottom);
    expect(contentHeight).toBeGreaterThan(0);
  });

  it("renders only visible markers at the source scanline", async () => {
    render(
      <ReaderGutterHarness highlights={[highlight("h1", 10), highlight("h2", 260)]}>
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 48, left: 0, width: 120, height: 24 }}
        >
          First target
        </span>
        <span
          data-active-highlight-ids="h2"
          style={{ position: "absolute", top: 260, left: 0, width: 120, height: 24 }}
        >
          Second target
        </span>
      </ReaderGutterHarness>,
    );

    const marker = await screen.findByTestId("reader-gutter-marker-h1");
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(48, 0);
    expect(screen.queryByTestId("reader-gutter-marker-h2")).toBeNull();
  });

  it("updates markers as highlights enter and leave the viewport", async () => {
    render(
      <ReaderGutterHarness highlights={[highlight("h1", 10), highlight("h2", 260)]}>
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 48, left: 0, width: 120, height: 24 }}
        >
          First target
        </span>
        <span
          data-active-highlight-ids="h2"
          style={{ position: "absolute", top: 260, left: 0, width: 120, height: 24 }}
        >
          Second target
        </span>
      </ReaderGutterHarness>,
    );

    expect(await screen.findByTestId("reader-gutter-marker-h1")).toBeTruthy();
    const scroll = screen.getByTestId("reader-scroll");
    scroll.scrollTop = 220;
    fireEvent.scroll(scroll);

    await waitFor(() => {
      const marker = screen.getByTestId("reader-gutter-marker-h2");
      expect(Number.parseFloat(marker.style.top)).toBeCloseTo(40, 0);
      expect(screen.queryByTestId("reader-gutter-marker-h1")).toBeNull();
    });
  });

  it("clusters overlapping visible markers, focuses the primary highlight, and dispatches its pulse", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    const events: ReaderPulseTarget[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<ReaderPulseTarget>).detail);
    };
    window.addEventListener(READER_PULSE_HIGHLIGHT, handler);

    render(
      <ReaderGutterHarness
        highlights={[highlight("h1", 10), highlight("h2", 10)]}
        onFocusHighlight={onFocusHighlight}
      >
        <span
          data-active-highlight-ids="h1 h2"
          style={{ position: "absolute", top: 72, left: 0, width: 120, height: 24 }}
        >
          Shared target
        </span>
      </ReaderGutterHarness>,
    );

    const marker = await screen.findByTestId("reader-gutter-marker-h1");
    expect(marker).toHaveAccessibleName("2 highlights at this position");
    expect(screen.queryByTestId("reader-gutter-marker-h2")).toBeNull();

    await user.click(marker);
    expect(onFocusHighlight).toHaveBeenCalledWith("h1");
    expect(events[0]).toMatchObject({ highlightId: "h1", snippet: "Quote h1" });
    window.removeEventListener(READER_PULSE_HIGHLIGHT, handler);
  });

  it("focuses and dispatches the clicked marker target", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    const events: ReaderPulseTarget[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<ReaderPulseTarget>).detail);
    };
    window.addEventListener(READER_PULSE_HIGHLIGHT, handler);

    render(
      <ReaderGutterHarness
        highlights={[highlight("h1", 10)]}
        onFocusHighlight={onFocusHighlight}
      >
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 72, left: 0, width: 120, height: 24 }}
        >
          Target
        </span>
      </ReaderGutterHarness>,
    );

    await user.click(await screen.findByTestId("reader-gutter-marker-h1"));
    expect(onFocusHighlight).toHaveBeenCalledWith("h1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mediaId: "media-1",
      highlightId: "h1",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 10,
        end_offset: 20,
      },
      snippet: "Quote h1",
    });

    window.removeEventListener(READER_PULSE_HIGHLIGHT, handler);
  });

  it("shows a hover preview for a visible marker", async () => {
    render(
      <ReaderGutterHarness highlights={[highlight("h1", 10)]}>
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 72, left: 0, width: 120, height: 24 }}
        >
          Target
        </span>
      </ReaderGutterHarness>,
    );

    fireEvent.pointerEnter(await screen.findByTestId("reader-gutter-marker-h1"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("Quote h1");
    });
  });

  it("renders a newly added visible highlight at its source scanline", async () => {
    const { rerender } = render(
      <ReaderGutterHarness highlights={[highlight("h1", 10)]}>
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 48, left: 0, width: 120, height: 24 }}
        >
          First target
        </span>
      </ReaderGutterHarness>,
    );

    expect(await screen.findByTestId("reader-gutter-marker-h1")).toBeTruthy();

    rerender(
      <ReaderGutterHarness highlights={[highlight("h1", 10), highlight("h2", 90)]}>
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 48, left: 0, width: 120, height: 24 }}
        >
          First target
        </span>
        <span
          data-active-highlight-ids="h2"
          style={{ position: "absolute", top: 96, left: 0, width: 120, height: 24 }}
        >
          New target
        </span>
      </ReaderGutterHarness>,
    );

    const marker = await screen.findByTestId("reader-gutter-marker-h2");
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(96, 0);
  });

  it("remeasures an existing marker when measureKey changes", async () => {
    const { rerender } = render(
      <ReaderGutterHarness highlights={[highlight("h1", 10)]} measureKey="v1">
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 48, left: 0, width: 120, height: 24 }}
        >
          Target
        </span>
      </ReaderGutterHarness>,
    );

    expect(
      Number.parseFloat((await screen.findByTestId("reader-gutter-marker-h1")).style.top),
    ).toBeCloseTo(48, 0);

    rerender(
      <ReaderGutterHarness highlights={[highlight("h1", 10)]} measureKey="v2">
        <span
          data-active-highlight-ids="h1"
          style={{ position: "absolute", top: 96, left: 0, width: 120, height: 24 }}
        >
          Target
        </span>
      </ReaderGutterHarness>,
    );

    await waitFor(() => {
      expect(
        Number.parseFloat(screen.getByTestId("reader-gutter-marker-h1").style.top),
      ).toBeCloseTo(96, 0);
    });
  });

  it("invokes onExpand when the expand affordance is activated", async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    render(<ReaderGutterHarness highlights={[]} onExpand={onExpand}>{null}</ReaderGutterHarness>);

    await user.click(
      screen.getByRole("button", { name: "Open highlights pane" }),
    );
    await waitFor(() => {
      expect(onExpand).toHaveBeenCalledTimes(1);
    });
  });
});
