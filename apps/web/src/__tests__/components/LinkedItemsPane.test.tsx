import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefObject } from "react";
import LinkedItemsPane from "@/components/LinkedItemsPane";

function getRowButtons(): HTMLDivElement[] {
  return screen
    .getAllByRole("button")
    .filter((el) => el.getAttribute("aria-pressed") !== null) as HTMLDivElement[];
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

  const contentRef = { current: contentRoot } as RefObject<HTMLElement | null>;
  return { host, contentRoot, contentRef };
}

afterEach(() => {
  document.querySelectorAll('[data-test-scroll-host="true"]').forEach((node) => node.remove());
});

describe("LinkedItemsPane", () => {
  it("applies cross-pane baseline offset in aligned mode", async () => {
    const { host, contentRef, contentRoot } = createScrollableContent(
      '<p><span data-highlight-anchor="offset-h"></span>offset target</p>'
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

    const linkedItemsContainer = document.querySelector('[class*="linkedItemsContainer"]');
    if (!(linkedItemsContainer instanceof HTMLDivElement)) {
      throw new Error("Expected linked-items container element");
    }
    const anchor = contentRoot.querySelector<HTMLElement>('[data-highlight-anchor="offset-h"]');
    if (!anchor) {
      throw new Error("Expected highlight anchor element");
    }

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
      expect(rows[0]?.style.transform).toBe("translateY(160px)");
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
      '<p><span data-active-highlight-ids="pdf-h1">pdf target</span></p>'
    );
    host.setAttribute("data-test-scroll-host", "true");
    const segment = contentRoot.querySelector<HTMLElement>('[data-active-highlight-ids="pdf-h1"]');
    if (!segment) {
      throw new Error("Expected active highlight segment");
    }
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
        layoutMode="list"
      />
    );

    const rows = getRowButtons();
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("chapter 1 excerpt");
    expect(rows[1].textContent).toContain("chapter 3 excerpt");

    await user.click(rows[1]);
    expect(onHighlightClick).toHaveBeenCalledWith("h-2");
  });

  it("virtualizes large list-mode highlight sets and renders new rows on scroll", async () => {
    const highlights = Array.from({ length: 240 }, (_, idx) => ({
      id: `h-${idx}`,
      exact: `virtual row ${idx}`,
      color: "yellow" as const,
      annotation: null,
      fragment_idx: Math.floor(idx / 40),
      start_offset: idx * 3,
      end_offset: idx * 3 + 2,
      created_at: "2026-01-01T00:00:00Z",
    }));

    render(
      <div style={{ height: "320px" }}>
        <LinkedItemsPane
          highlights={highlights as never}
          contentRef={{ current: null }}
          focusedId={null}
          onHighlightClick={vi.fn()}
          layoutMode="list"
        />
      </div>
    );

    await waitFor(() => {
      expect(screen.getByText("virtual row 0")).toBeInTheDocument();
    });

    expect(screen.getByText("virtual row 0")).toBeInTheDocument();
    expect(screen.queryByText("virtual row 239")).not.toBeInTheDocument();

    const renderedRowsBefore = getRowButtons().length;
    expect(renderedRowsBefore).toBeLessThan(120);

    const listContainer = document.querySelector('[class*="linkedItemsContainer"]');
    if (!(listContainer instanceof HTMLDivElement)) {
      throw new Error("Expected linked-items container to render for virtualization test");
    }

    listContainer.scrollTop = 7000;
    listContainer.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      expect(screen.getByText("virtual row 230")).toBeInTheDocument();
    });
    expect(screen.queryByText("virtual row 0")).not.toBeInTheDocument();
  });

  it("shows list-mode overflow count for highlights below the viewport", async () => {
    const highlights = Array.from({ length: 140 }, (_, idx) => ({
      id: `overflow-${idx}`,
      exact: `overflow row ${idx}`,
      color: "yellow" as const,
      annotation: null,
      fragment_idx: Math.floor(idx / 20),
      start_offset: idx * 4,
      end_offset: idx * 4 + 2,
      created_at: "2026-01-01T00:00:00Z",
    }));

    render(
      <div style={{ height: "300px" }}>
        <LinkedItemsPane
          highlights={highlights as never}
          contentRef={{ current: null }}
          focusedId={null}
          onHighlightClick={vi.fn()}
          layoutMode="list"
        />
      </div>
    );

    await waitFor(() => {
      expect(screen.getByText(/more below/i)).toBeInTheDocument();
    });
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
        layoutMode="list"
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
