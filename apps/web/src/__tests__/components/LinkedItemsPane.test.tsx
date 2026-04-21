import { describe, it, expect, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefObject } from "react";
import LinkedItemsPane from "@/components/LinkedItemsPane";

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const scrollHosts: HTMLDivElement[] = [];
const linkedItemsPaneBaseProps = {
  isEditingBounds: false,
  onSendToChat: vi.fn(),
  onColorChange: vi.fn(async () => undefined),
  onDelete: vi.fn(async () => undefined),
  onStartEditBounds: vi.fn(),
  onCancelEditBounds: vi.fn(),
  onAnnotationSave: vi.fn(async () => undefined),
  onAnnotationDelete: vi.fn(async () => undefined),
  onOpenConversation: vi.fn(),
} as const;

function getRowButtons(): HTMLButtonElement[] {
  return screen
    .getAllByRole("button")
    .filter((el) => el.getAttribute("aria-pressed") !== null) as HTMLButtonElement[];
}

function createScrollableContent(innerHtml: string): {
  host: HTMLDivElement;
  contentRoot: HTMLDivElement;
  contentRef: RefObject<HTMLElement | null>;
} {
  const host = document.createElement("div");
  host.style.height = "320px";
  host.style.overflowY = "auto";
  host.style.position = "relative";
  Object.defineProperty(host, "clientHeight", {
    configurable: true,
    value: 320,
  });
  Object.defineProperty(host, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  });

  const contentRoot = document.createElement("div");
  contentRoot.innerHTML = innerHtml;
  host.appendChild(contentRoot);
  document.body.appendChild(host);
  scrollHosts.push(host);

  const contentRef = { current: contentRoot } as RefObject<HTMLElement | null>;
  return { host, contentRoot, contentRef };
}

function mockViewportAnchors(
  host: HTMLDivElement,
  contentRoot: HTMLDivElement,
  anchors: Record<string, { absoluteTop: number; height?: number }>,
  viewportTop = 100,
  viewportHeight = 320
) {
  vi.spyOn(host, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, viewportTop, 400, viewportHeight)
  );

  for (const [testId, { absoluteTop, height = 16 }] of Object.entries(anchors)) {
    const anchor = within(contentRoot).getByTestId(testId);
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, viewportTop + absoluteTop - host.scrollTop, 80, height)
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  while (scrollHosts.length > 0) {
    scrollHosts.pop()?.remove();
  }
});

describe("LinkedItemsPane", () => {
  it("applies cross-pane baseline offset in aligned mode", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      '<p><span data-highlight-anchor="offset-h" data-testid="offset-anchor"></span>offset target</p>'
    );
    host.setAttribute("data-test-scroll-host", "true");

    const highlights = [
      {
        id: "offset-h",
        exact: "offset target",
        color: "yellow" as const,
        annotation: null,
        start_offset: 0,
        end_offset: 12,
        created_at: "2026-01-01T00:00:00Z",
      },
    ] as const;

    const { rerender } = render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={highlights as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile={false}
        onHighlightClick={vi.fn()}
        highlightsVersion={0}
      />
    );

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });

    const linkedItemsContainer = screen.getByTestId("linked-items-container");
    const anchor = within(contentRoot).getByTestId("offset-anchor");

    const hostRectSpy = vi
      .spyOn(host, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 200, 400, 320));
    const paneRectSpy = vi
      .spyOn(linkedItemsContainer, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 100, 360, 320));
    const anchorRectSpy = vi
      .spyOn(anchor, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 260, 80, 16));

    rerender(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={highlights as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile={false}
        onHighlightClick={vi.fn()}
        highlightsVersion={1}
      />
    );

    await waitFor(() => {
      const rows = getRowButtons();
      expect(rows).toHaveLength(1);
      expect(screen.getByTestId("linked-item-row-offset-h").style.transform).toBe(
        "translateY(160px)"
      );
    });

    hostRectSpy.mockRestore();
    paneRectSpy.mockRestore();
    anchorRectSpy.mockRestore();
  });

  it("orders same-line rows by canonical offsets, not random id fallback", async () => {
    const { host, contentRef } = createScrollableContent(
      [
        '<p><span data-highlight-anchor="a-late"></span>late token ',
        '<span data-highlight-anchor="z-early"></span>early token</p>',
      ].join("")
    );
    host.setAttribute("data-test-scroll-host", "true");

    const highlights = [
      {
        id: "a-late",
        exact: "late token",
        color: "yellow" as const,
        annotation: null,
        start_offset: 10,
        end_offset: 19,
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "z-early",
        exact: "early token",
        color: "green" as const,
        annotation: null,
        start_offset: 1,
        end_offset: 10,
        created_at: "2026-01-01T00:00:00Z",
      },
    ] as const;

    render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={highlights as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile={false}
        onHighlightClick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(2);
    });

    const rows = getRowButtons();
    expect(rows[0].textContent).toContain("early token");
    expect(rows[1].textContent).toContain("late token");
  });

  it("scrolls to active-highlight segments when anchor marker is absent", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      '<p><span data-active-highlight-ids="pdf-h1" data-testid="active-highlight-segment">pdf target</span></p>'
    );
    host.setAttribute("data-test-scroll-host", "true");
    const segment = within(contentRoot).getByTestId("active-highlight-segment");
    const scrollIntoViewSpy = vi
      .spyOn(segment, "scrollIntoView")
      .mockImplementation(() => undefined);

    render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={[
          {
            id: "pdf-h1",
            exact: "pdf target",
            color: "yellow",
            annotation: null,
            start_offset: 0,
            end_offset: 10,
            created_at: "2026-01-01T00:00:00Z",
          },
        ] as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile={false}
        onHighlightClick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });
    await userEvent.click(getRowButtons()[0]);
    expect(scrollIntoViewSpy).toHaveBeenCalledOnce();
    scrollIntoViewSpy.mockRestore();
  });

  it("on mobile, renders only in-view rows and shows explicit above/below indicators", async () => {
    const onHighlightClick = vi.fn();
    const user = userEvent.setup();
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-highlight-anchor="above-h" data-testid="anchor-above"></span>above excerpt</p>',
        '<p><span data-highlight-anchor="in-view-h" data-testid="anchor-in-view"></span>current excerpt</p>',
        '<p><span data-highlight-anchor="below-h" data-testid="anchor-below"></span>below excerpt</p>',
      ].join("")
    );
    host.scrollTop = 200;
    mockViewportAnchors(host, contentRoot, {
      "anchor-above": { absoluteTop: 120 },
      "anchor-in-view": { absoluteTop: 260 },
      "anchor-below": { absoluteTop: 580 },
    });

    render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={[
          {
            id: "above-h",
            exact: "above excerpt",
            color: "yellow",
            annotation: null,
            fragment_idx: 0,
            start_offset: 0,
            end_offset: 12,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "in-view-h",
            exact: "current excerpt",
            color: "blue",
            annotation: null,
            fragment_idx: 1,
            start_offset: 20,
            end_offset: 35,
            created_at: "2026-01-02T00:00:00Z",
          },
          {
            id: "below-h",
            exact: "below excerpt",
            color: "blue",
            annotation: null,
            fragment_idx: 2,
            start_offset: 40,
            end_offset: 53,
            created_at: "2026-01-03T00:00:00Z",
          },
        ] as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile
        onHighlightClick={onHighlightClick}
      />
    );

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });

    expect(screen.getByTestId("linked-item-row-in-view-h")).toBeInTheDocument();
    expect(screen.queryByTestId("linked-item-row-above-h")).not.toBeInTheDocument();
    expect(screen.queryByTestId("linked-item-row-below-h")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 above" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 below" })).toBeInTheDocument();
    expect(screen.queryByText("No highlights in view.")).not.toBeInTheDocument();

    await user.click(getRowButtons()[0]);
    expect(onHighlightClick).toHaveBeenCalledWith("in-view-h");
  });

  it("keeps collapsed rows compact without inline note, chat, or conversation chrome", async () => {
    const { host, contentRef } = createScrollableContent(
      '<p><span data-highlight-anchor="compact-h1"></span>compact row preview</p>'
    );
    host.setAttribute("data-test-scroll-host", "true");

    render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={[
          {
            id: "compact-h1",
            exact: "compact row preview",
            color: "yellow",
            annotation: {
              id: "annotation-1",
              body: "This note should stay hidden while the row is collapsed.",
            },
            linked_conversations: [
              {
                conversation_id: "conversation-1",
                title: "Context thread",
              },
            ],
            fragment_idx: 0,
            start_offset: 0,
            end_offset: 20,
            created_at: "2026-01-01T00:00:00Z",
          },
        ] as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile
        onHighlightClick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });

    const row = screen.getByTestId("linked-item-row-compact-h1");
    expect(within(row).getByText("compact row preview")).toBeInTheDocument();
    expect(
      within(row).queryByText("This note should stay hidden while the row is collapsed.")
    ).not.toBeInTheDocument();
    expect(within(row).queryByText("Add a note…")).not.toBeInTheDocument();
    expect(within(row).queryByText("Context thread")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Send to chat" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });

  it("on mobile, swaps rows as highlights move into and out of the reader viewport", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-highlight-anchor="above-h" data-testid="scroll-anchor-above"></span>above excerpt</p>',
        '<p><span data-highlight-anchor="mid-h" data-testid="scroll-anchor-mid"></span>mid excerpt</p>',
        '<p><span data-highlight-anchor="lower-h" data-testid="scroll-anchor-lower"></span>lower excerpt</p>',
      ].join("")
    );
    host.scrollTop = 200;
    mockViewportAnchors(host, contentRoot, {
      "scroll-anchor-above": { absoluteTop: 120 },
      "scroll-anchor-mid": { absoluteTop: 260 },
      "scroll-anchor-lower": { absoluteTop: 580 },
    });

    render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={[
          {
            id: "above-h",
            exact: "above excerpt",
            color: "yellow",
            annotation: null,
            fragment_idx: 0,
            start_offset: 0,
            end_offset: 12,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "mid-h",
            exact: "mid excerpt",
            color: "green",
            annotation: null,
            fragment_idx: 1,
            start_offset: 20,
            end_offset: 31,
            created_at: "2026-01-02T00:00:00Z",
          },
          {
            id: "lower-h",
            exact: "lower excerpt",
            color: "blue",
            annotation: null,
            fragment_idx: 2,
            start_offset: 40,
            end_offset: 53,
            created_at: "2026-01-03T00:00:00Z",
          },
        ] as never}
        contentRef={contentRef}
        focusedId="mid-h"
        isMobile
        onHighlightClick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("linked-item-row-mid-h")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("linked-item-row-lower-h")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 above" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 below" })).toBeInTheDocument();

    host.scrollTop = 540;
    fireEvent.scroll(host);

    await waitFor(() => {
      expect(screen.getByTestId("linked-item-row-lower-h")).toBeInTheDocument();
      expect(screen.queryByTestId("linked-item-row-mid-h")).not.toBeInTheDocument();
    });

    expect(
      within(screen.getByTestId("linked-item-row-lower-h")).getByRole("button", { pressed: false })
    ).toHaveTextContent("lower excerpt");
    expect(screen.queryByRole("button", { pressed: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 above" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1 below" })).not.toBeInTheDocument();
  });

  it("on mobile, shows No highlights in view when the contextual set is entirely offscreen", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-highlight-anchor="far-above-h" data-testid="empty-anchor-above"></span>far above excerpt</p>',
        '<p><span data-highlight-anchor="far-below-h1" data-testid="empty-anchor-below-1"></span>far below excerpt 1</p>',
        '<p><span data-highlight-anchor="far-below-h2" data-testid="empty-anchor-below-2"></span>far below excerpt 2</p>',
      ].join("")
    );
    host.scrollTop = 300;
    mockViewportAnchors(host, contentRoot, {
      "empty-anchor-above": { absoluteTop: 120 },
      "empty-anchor-below-1": { absoluteTop: 700 },
      "empty-anchor-below-2": { absoluteTop: 860 },
    });

    render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={[
          {
            id: "far-above-h",
            exact: "far above excerpt",
            color: "yellow",
            annotation: null,
            fragment_idx: 0,
            start_offset: 0,
            end_offset: 17,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "far-below-h1",
            exact: "far below excerpt 1",
            color: "green",
            annotation: null,
            fragment_idx: 1,
            start_offset: 20,
            end_offset: 38,
            created_at: "2026-01-02T00:00:00Z",
          },
          {
            id: "far-below-h2",
            exact: "far below excerpt 2",
            color: "blue",
            annotation: null,
            fragment_idx: 2,
            start_offset: 40,
            end_offset: 58,
            created_at: "2026-01-03T00:00:00Z",
          },
        ] as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile
        onHighlightClick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("No highlights in view.")).toBeInTheDocument();
    });

    expect(getRowButtons()).toHaveLength(0);
    expect(screen.queryByTestId("linked-item-row-far-above-h")).not.toBeInTheDocument();
    expect(screen.queryByTestId("linked-item-row-far-below-h1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("linked-item-row-far-below-h2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 above" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 below" })).toBeInTheDocument();
  });

  it("keeps the aligned desktop list clipped to the pane (overflow: hidden)", async () => {
    const { host, contentRef } = createScrollableContent(
      '<p><span data-highlight-anchor="clip-h1"></span>clipped item</p>'
    );
    host.setAttribute("data-test-scroll-host", "true");

    render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={[
          {
            id: "clip-h1",
            exact: "clipped item",
            color: "yellow",
            annotation: null,
            start_offset: 0,
            end_offset: 12,
            created_at: "2026-01-01T00:00:00Z",
          },
        ] as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile={false}
        onHighlightClick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });

    const container = screen.getByTestId("linked-items-container");
    const style = window.getComputedStyle(container);
    expect(
      style.overflowY,
      "Aligned mode container should have overflow: hidden — rows are absolutely positioned"
    ).toBe("hidden");
  });

  it("uses stable_order_key for deterministic mobile row ordering", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      [
        '<p><span data-highlight-anchor="h-b" data-testid="stable-anchor-b"></span>row b ',
        '<span data-highlight-anchor="h-a" data-testid="stable-anchor-a"></span>row a</p>',
      ].join("")
    );
    host.scrollTop = 0;
    mockViewportAnchors(host, contentRoot, {
      "stable-anchor-b": { absoluteTop: 40 },
      "stable-anchor-a": { absoluteTop: 40 },
    });

    render(
      <LinkedItemsPane
        {...linkedItemsPaneBaseProps}
        highlights={[
          {
            id: "h-b",
            exact: "row b",
            color: "yellow",
            annotation: null,
            fragment_idx: 1,
            start_offset: 100,
            end_offset: 120,
            created_at: "2026-01-01T00:00:00Z",
            stable_order_key: "00000001:000000000100.000000:000000000072.000000:2026-01-01T00:00:00Z:h-b",
          },
          {
            id: "h-a",
            exact: "row a",
            color: "yellow",
            annotation: null,
            fragment_idx: 1,
            start_offset: 100,
            end_offset: 120,
            created_at: "2026-01-01T00:00:00Z",
            stable_order_key: "00000001:000000000100.000000:000000000072.000000:2026-01-01T00:00:00Z:h-a",
          },
        ] as never}
        contentRef={contentRef}
        focusedId={null}
        isMobile
        onHighlightClick={vi.fn()}
      />
    );

    await waitFor(() => {
      const rows = getRowButtons();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain("row a");
      expect(rows[1]?.textContent).toContain("row b");
    });
  });
});
