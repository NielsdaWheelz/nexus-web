import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefObject } from "react";
import LinkedItemsPane from "@/components/LinkedItemsPane";

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const scrollHosts: HTMLDivElement[] = [];

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

  const contentRoot = document.createElement("div");
  contentRoot.innerHTML = innerHtml;
  host.appendChild(contentRoot);
  document.body.appendChild(host);
  scrollHosts.push(host);

  const contentRef = { current: contentRoot } as RefObject<HTMLElement | null>;
  return { host, contentRoot, contentRef };
}

afterEach(() => {
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
        highlights={highlights as never}
        contentRef={contentRef}
        focusedId={null}
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
        highlights={highlights as never}
        contentRef={contentRef}
        focusedId={null}
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
        highlights={highlights as never}
        contentRef={contentRef}
        focusedId={null}
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

  it("renders in list mode without requiring highlight anchors", async () => {
    const onHighlightClick = vi.fn();
    const user = userEvent.setup();

    render(
      <LinkedItemsPane
        highlights={[
          {
            id: "h-1",
            exact: "chapter 1 excerpt",
            color: "yellow",
            annotation: null,
            fragment_idx: 0,
            start_offset: 2,
            end_offset: 18,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "h-2",
            exact: "chapter 3 excerpt",
            color: "blue",
            annotation: null,
            fragment_idx: 2,
            start_offset: 1,
            end_offset: 14,
            created_at: "2026-01-02T00:00:00Z",
          },
        ] as never}
        contentRef={{ current: null }}
        focusedId={null}
        onHighlightClick={onHighlightClick}
        alignToContent={false}
      />
    );

    const rows = getRowButtons();
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("chapter 1 excerpt");
    expect(rows[1].textContent).toContain("chapter 3 excerpt");

    await user.click(rows[1]);
    expect(onHighlightClick).toHaveBeenCalledWith("h-2");
  });

  it("keeps collapsed rows compact without inline note, chat, or conversation chrome", async () => {
    render(
      <LinkedItemsPane
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
        contentRef={{ current: null }}
        focusedId={null}
        onHighlightClick={vi.fn()}
        alignToContent={false}
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

  it("marks only the focused row selected and scrolls it into view in list mode", async () => {
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);

    render(
      <LinkedItemsPane
        highlights={[
          {
            id: "focus-1",
            exact: "focus row 1",
            color: "yellow",
            annotation: null,
            fragment_idx: 0,
            start_offset: 0,
            end_offset: 8,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "focus-2",
            exact: "focus row 2",
            color: "green",
            annotation: null,
            fragment_idx: 0,
            start_offset: 9,
            end_offset: 17,
            created_at: "2026-01-01T00:00:00Z",
          },
        ] as never}
        contentRef={{ current: null }}
        focusedId="focus-2"
        onHighlightClick={vi.fn()}
        alignToContent={false}
      />
    );

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(2);
    });

    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent("focus row 2");
    expect(
      within(screen.getByTestId("linked-item-row-focus-1")).getByRole("button", { pressed: false })
    ).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(scrollIntoViewSpy).toHaveBeenCalled();
    scrollIntoViewSpy.mockRestore();
  });

  it("keeps the single-pane list scrollable in list mode (overflow-y: auto)", async () => {
    render(
      <div style={{ height: "200px" }}>
        <LinkedItemsPane
          highlights={[
            {
              id: "scroll-h1",
              exact: "scrollable item",
              color: "yellow",
              annotation: null,
              fragment_idx: 0,
              start_offset: 0,
              end_offset: 14,
              created_at: "2026-01-01T00:00:00Z",
            },
          ] as never}
          contentRef={{ current: null }}
          focusedId={null}
          onHighlightClick={vi.fn()}
          alignToContent={false}
        />
      </div>
    );

    await waitFor(() => {
      expect(getRowButtons()).toHaveLength(1);
    });

    const container = screen.getByTestId("linked-items-container");
    const style = window.getComputedStyle(container);
    expect(
      style.overflowY,
      "List mode container should have overflow-y: auto for mobile scrolling"
    ).toBe("auto");
  });

  it("keeps the aligned desktop list clipped to the pane (overflow: hidden)", async () => {
    const { host, contentRef } = createScrollableContent(
      '<p><span data-highlight-anchor="clip-h1"></span>clipped item</p>'
    );
    host.setAttribute("data-test-scroll-host", "true");

    render(
      <LinkedItemsPane
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
        onHighlightClick={vi.fn()}
        alignToContent
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

  it("uses stable_order_key for deterministic list ordering", async () => {
    render(
      <LinkedItemsPane
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
        contentRef={{ current: null }}
        focusedId={null}
        onHighlightClick={vi.fn()}
        alignToContent={false}
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
