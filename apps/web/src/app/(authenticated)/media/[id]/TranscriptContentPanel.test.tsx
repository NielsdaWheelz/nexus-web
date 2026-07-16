import { createRef, type CSSProperties } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TranscriptContentPanel from "./TranscriptContentPanel";
import type { TranscriptFragment } from "@/lib/media/transcriptView";
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

    expect((root as HTMLElement).style.getPropertyValue("--reader-font-size-px")).toBe(
      "18px",
    );
    expect(
      (root as HTMLElement).style.getPropertyValue("--reader-column-width-ch"),
    ).toBe("70ch");
  });

  it("keeps the partial-coverage warning inside the themed root", () => {
    renderPanel({ transcriptCoverage: "partial" });

    const warning = screen.getByText(
      "Transcript is partial; search and highlights may miss sections.",
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the warning sits inside the themed reader root, a CSS-module class with no ARIA role/label
    expect(warning.closest(`.${styles.readerThemeDark}`)).not.toBeNull();
  });

  it("keeps the empty state inside the themed root when there are no fragments", () => {
    renderPanel({ fragments: [], activeFragment: null });

    const empty = screen.getByText("No transcript segments available.");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the empty state sits inside the themed reader root, a CSS-module class with no ARIA role/label
    expect(empty.closest(`.${styles.readerThemeDark}`)).not.toBeNull();
    expect(screen.queryByText("Active fragment prose.")).not.toBeInTheDocument();
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
});
