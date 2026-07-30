import { createRef, type CSSProperties } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TranscriptContentPanel from "./TranscriptContentPanel";
import type { TranscriptFragment } from "@/lib/media/transcriptView";
import { createPaneFindResultKey } from "@/lib/panes/paneSearch";
import styles from "./page.module.css";

const READER_SURFACE_STYLE = {
  "--reader-font-family": "Georgia, serif",
  "--reader-font-size-px": "18px",
  "--reader-line-height": "1.6",
  "--reader-column-width-ch": "70ch",
} as CSSProperties;

const READER_SURFACE_CLASS_NAME = `${styles.readerContentRoot} ${styles.readerThemeDark}`;

const FRAGMENTS: TranscriptFragment[] = [
  {
    id: "frag-1",
    canonical_text: "First segment text.",
    t_start_ms: 0,
    t_end_ms: 4_000,
    speaker_label: "Speaker A",
  },
  {
    id: "frag-2",
    canonical_text: "Second segment text.",
    t_start_ms: 4_000,
    t_end_ms: 8_000,
    speaker_label: "Speaker B",
  },
];

function renderPanel(
  overrides: Partial<Parameters<typeof TranscriptContentPanel>[0]> = {},
) {
  const onSegmentSelect = vi.fn();
  const onSeek = vi.fn();
  const onContentClick = vi.fn();
  const onContentPointerOver = vi.fn();
  const onContentPointerOut = vi.fn();
  const props: Parameters<typeof TranscriptContentPanel>[0] = {
    mediaId: "media-1",
    transcriptState: "ready",
    transcriptCoverage: "full",
    chapters: [],
    fragments: FRAGMENTS,
    activeFragment: FRAGMENTS[0],
    renderedHtml: "<p>Active fragment prose.</p>",
    readerSurfaceClassName: READER_SURFACE_CLASS_NAME,
    readerSurfaceStyle: READER_SURFACE_STYLE,
    contentRef: createRef<HTMLDivElement>(),
    segmentListRef: createRef<HTMLDivElement>(),
    findPresentation: { kind: "Text" },
    onFindMatchElement: vi.fn(),
    onSegmentSelect,
    onSeek,
    onContentClick,
    onContentPointerOver,
    onContentPointerOut,
    ...overrides,
  };

  const view = render(<TranscriptContentPanel {...props} />);
  return {
    ...view,
    onSegmentSelect,
    onSeek,
    onContentClick,
    onContentPointerOver,
    onContentPointerOut,
  };
}

describe("TranscriptContentPanel", () => {
  it("projects imported transcript h1 beneath the route heading", () => {
    renderPanel({ renderedHtml: '<h1 id="transcript-topic">Topic</h1>' });

    expect(
      screen.queryByRole("heading", { level: 1, name: "Topic" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Topic" }),
    ).toHaveAttribute("id", "transcript-topic");
  });

  it("renders without a ReaderProvider in the tree", () => {
    // No context read remains in this component; wrapping it in a
    // ReaderProvider here would hide a regression that reintroduces one.
    expect(() => renderPanel()).not.toThrow();
  });

  it("wraps the timeline and active prose in a single themed root", () => {
    renderPanel();

    const firstSegment = screen.getByText("First segment text.");
    const secondSegment = screen.getByText("Second segment text.");
    const activeProse = screen.getByText("Active fragment prose.");

    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting containment inside the themed reader root, a CSS-module class with no ARIA role/label
    const root = firstSegment.closest(`.${styles.readerThemeDark}`);
    expect(root).not.toBeNull();
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: same themed-root containment check for the second segment
    expect(secondSegment.closest(`.${styles.readerThemeDark}`)).toBe(root);
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: same themed-root containment check for the active prose block
    expect(activeProse.closest(`.${styles.readerThemeDark}`)).toBe(root);

    expect(
      (root as HTMLElement).style.getPropertyValue("--reader-font-size-px"),
    ).toBe("18px");
    expect(
      (root as HTMLElement).style.getPropertyValue("--reader-column-width-ch"),
    ).toBe("70ch");
  });

  it("keeps the partial-coverage warning inside the themed root", () => {
    renderPanel({ transcriptCoverage: "partial" });

    const warning = screen.getByText(
      "Transcript is partial; search and highlights cover only the available transcript.",
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the warning sits inside the themed reader root, a CSS-module class with no ARIA role/label
    expect(warning.closest(`.${styles.readerThemeDark}`)).not.toBeNull();
  });

  it("keeps the empty state inside the themed root when there are no fragments", () => {
    renderPanel({ fragments: [], activeFragment: null });

    const empty = screen.getByText("No transcript segments available.");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the empty state sits inside the themed reader root, a CSS-module class with no ARIA role/label
    expect(empty.closest(`.${styles.readerThemeDark}`)).not.toBeNull();
    expect(
      screen.queryByText("Active fragment prose."),
    ).not.toBeInTheDocument();
  });

  it("scopes .readerContentInner to the active prose block only", () => {
    renderPanel();

    const activeProse = screen.getByText("Active fragment prose.");
    const firstSegment = screen.getByText("First segment text.");

    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: confirming the prose block is wrapped by the prose-only inner column, a CSS-module class with no ARIA role/label
    expect(activeProse.closest(`.${styles.readerContentInner}`)).not.toBeNull();
    // The segment timeline is a sibling of readerContentInner, not nested
    // inside it — only the prose block gets the column-width constraint.
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: confirming the timeline is NOT wrapped by the prose-only inner column
    expect(firstSegment.closest(`.${styles.readerContentInner}`)).toBeNull();
  });

  it("exposes the segment list as the programmatic reading-focus target", () => {
    const segmentListRef = createRef<HTMLDivElement>();
    renderPanel({ segmentListRef });

    const segmentList = screen.getByRole("region", {
      name: "Transcript segments",
    });
    expect(segmentListRef.current).toBe(segmentList);
    segmentList.focus();
    expect(segmentList).toHaveFocus();
  });

  it("renders only exact supplied occurrences and labels the active match", () => {
    const firstKey = createPaneFindResultKey({
      source: { fragmentId: "frag-1" },
      locator: { startCp: 0, endCp: 6 },
    });
    const activeKey = createPaneFindResultKey({
      source: { fragmentId: "frag-1" },
      locator: { startCp: 14, endCp: 20 },
    });
    const onFindMatchElement = vi.fn();
    renderPanel({
      fragments: [
        {
          ...FRAGMENTS[0],
          canonical_text: "needle needle needle",
        },
      ],
      activeFragment: {
        ...FRAGMENTS[0],
        canonical_text: "needle needle needle",
      },
      findPresentation: {
        kind: "Matches",
        activeKey,
        occurrences: [
          {
            key: firstKey,
            fragmentId: "frag-1",
            startCp: 0,
            endCp: 6,
          },
          {
            key: activeKey,
            fragmentId: "frag-1",
            startCp: 14,
            endCp: 20,
          },
        ],
      },
      onFindMatchElement,
    });

    const marks = screen.getAllByRole("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent("needle");
    expect(marks[0]).not.toHaveAttribute("aria-current");
    expect(marks[1]).toHaveTextContent("needle");
    expect(marks[1]).toHaveAttribute("aria-current", "true");
    expect(marks[1]).toHaveAccessibleName("Current match: needle");
    expect(
      screen.getByRole("button", { name: /Current match: needle/ }),
    ).toBeVisible();
    expect(screen.getAllByText("needle")).toHaveLength(3);

    const registered = onFindMatchElement.mock.calls
      .filter(([, element]) => element !== null)
      .map(([key, element]) => ({ key, element }));
    expect(registered).toEqual([
      { key: firstKey, element: marks[0] },
      { key: activeKey, element: marks[1] },
    ]);
  });

  it("keeps ordinary segment selection and seek behavior unchanged", () => {
    const { onSegmentSelect, onSeek } = renderPanel();

    fireEvent.click(
      screen.getByRole("button", {
        name: "00:00:04 Speaker B Second segment text.",
      }),
    );

    expect(onSegmentSelect).toHaveBeenCalledWith(FRAGMENTS[1]);
    expect(onSeek).toHaveBeenCalledWith(4_000);
  });
});
