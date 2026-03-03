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
});
