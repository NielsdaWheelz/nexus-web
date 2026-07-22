import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MarginItem } from "@/lib/reader/marginItems";
import MarginRail, { MarginItemBody } from "./MarginRail";
import type { AnchoredReaderRow } from "./useAnchoredReaderProjection";

const anchor: AnchoredReaderRow = {
  id: "highlight:h1",
  exact: "Quote",
  color: "yellow",
  anchor: { fragment_id: "fragment-1", start_offset: 0, end_offset: 4 },
  stable_order_key: "document:0001",
};

function item(
  kind: MarginItem["kind"],
  extra: Partial<MarginItem> = {},
): MarginItem {
  return {
    id: `margin:${kind}:1`,
    itemId: `${kind}:1`,
    kind,
    anchor,
    label: `${kind} label`,
    ...extra,
  };
}

describe("MarginItemBody", () => {
  it("activates the canonical Evidence item", async () => {
    const onActivateItem = vi.fn();
    render(
      <MarginItemBody
        item={item("citation", { itemId: "source-reference:ref-1" })}
        onActivateItem={onActivateItem}
        onDismissSynapse={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /citation label/i }),
    );
    expect(onActivateItem).toHaveBeenCalledWith("source-reference:ref-1");
  });

  it("renders a link with a small-caps kicker and the target label", () => {
    render(
      <MarginItemBody
        item={item("link", { label: "The Other Work" })}
        onActivateItem={vi.fn()}
        onDismissSynapse={vi.fn()}
      />,
    );
    expect(screen.getByText("Link")).toBeInTheDocument();
    expect(screen.getByText("The Other Work")).toBeInTheDocument();
  });

  it("renders Synapse rationale as machine text with an independent dismiss action", async () => {
    const onActivateItem = vi.fn();
    const onDismiss = vi.fn();
    render(
      <MarginItemBody
        item={item("synapse", { excerpt: "These resonate", edgeId: "edge-1" })}
        onActivateItem={onActivateItem}
        onDismissSynapse={onDismiss}
      />,
    );
    expect(screen.getByText("These resonate")).toHaveAttribute(
      "data-machine-origin",
      "Synapse",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss Synapse connection" }),
    );
    expect(onDismiss).toHaveBeenCalledWith("edge-1");
    expect(onActivateItem).not.toHaveBeenCalled();
  });

  it.each([
    ["supports", "Conceded", "✓"],
    ["contradicts", "Doubted", "~"],
  ] as const)(
    "renders %s stance in the user register",
    (stance, label, glyph) => {
      render(
        <MarginItemBody
          item={item("stance", { stance })}
          onActivateItem={vi.fn()}
          onDismissSynapse={vi.fn()}
        />,
      );
      const mark = screen.getByRole("button", { name: label });
      expect(mark).toHaveTextContent(glyph);
      expect(mark).not.toHaveAttribute("data-machine-origin");
    },
  );
});

function MarginRailHarness() {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={contentRef}>Reader content</div>
      <MarginRail
        items={[item("highlight")]}
        contentRef={contentRef}
        measureKey="test"
        isMobile
        onOpenSidecar={vi.fn()}
        onActivateItem={vi.fn()}
        onDismissSynapse={vi.fn()}
      />
    </>
  );
}

describe("MarginRail breakpoint", () => {
  it("does not present an inline rail on mobile", () => {
    render(<MarginRailHarness />);
    expect(screen.queryByTestId("margin-rail")).not.toBeInTheDocument();
  });
});
