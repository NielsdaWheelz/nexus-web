import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import MarginRail, { MarginItemBody } from "./MarginRail";
import type { MarginItem } from "@/lib/reader/marginItems";
import type { AnchoredReaderRow } from "./useAnchoredReaderProjection";

const anchor: AnchoredReaderRow = {
  id: "a",
  exact: "x",
  color: "yellow",
  anchor: { fragment_id: "frag", start_offset: 0, end_offset: 4 },
  stable_order_key: "document:0001",
};

function item(kind: MarginItem["kind"], extra: Partial<MarginItem> = {}): MarginItem {
  return { id: `${kind}:1`, kind, orderKey: "document:0001", anchor, ...extra };
}

describe("MarginItemBody", () => {
  it("renders a user note in the user register (plain text)", () => {
    render(<MarginItemBody item={item("note", { noteText: "my note" })} onDismissSynapse={vi.fn()} />);
    expect(screen.getByText("my note")).toBeInTheDocument();
  });

  it("renders a synapse rationale through MachineText inline with a dismiss control", async () => {
    const onDismiss = vi.fn();
    render(
      <MarginItemBody
        item={item("synapse", { excerpt: "these resonate", edgeId: "e1" })}
        onDismissSynapse={onDismiss}
      />,
    );
    // MachineText inline stamps the Synapse origin label onto data-machine-origin.
    expect(screen.getByText("these resonate")).toHaveAttribute("data-machine-origin", "Synapse");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss Synapse connection" }));
    expect(onDismiss).toHaveBeenCalledWith("e1");
  });

  it("renders a footnote with a small-caps kicker and the target title", () => {
    render(
      <MarginItemBody
        item={item("footnote", { targetTitle: "The Other Work", targetHref: "/media/x#p" })}
        onDismissSynapse={vi.fn()}
      />,
    );
    expect(screen.getByText("Cite")).toBeInTheDocument();
    expect(screen.getByText("The Other Work")).toBeInTheDocument();
  });

  it("renders a doubt stance as user-register text (tilde), never a MachineText or pill", () => {
    render(
      <MarginItemBody item={item("stance", { stance: "contradicts" })} onDismissSynapse={vi.fn()} />,
    );
    const glyph = screen.getByLabelText("Doubted");
    expect(glyph).toHaveTextContent("~");
    // The stance glyph is the user's own ink, not a MachineText origin-labelled element.
    expect(glyph).not.toHaveAttribute("data-machine-origin");
  });

  it("renders a concede stance as user-register text (tick), never an icon", () => {
    render(
      <MarginItemBody item={item("stance", { stance: "supports" })} onDismissSynapse={vi.fn()} />,
    );
    const glyph = screen.getByLabelText("Conceded");
    expect(glyph).toHaveTextContent("✓");
    expect(glyph).not.toHaveAttribute("data-machine-origin");
  });
});

function MarginRailHarness({ isMobile }: { isMobile: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={contentRef} style={{ height: 400 }}>
        <p>Reader content</p>
      </div>
      <MarginRail
        items={[item("note", { noteText: "note" })]}
        hiddenByCap={0}
        contentRef={contentRef}
        measureKey="k"
        isMobile={isMobile}
        onOpenSidecar={vi.fn()}
        onDismissSynapse={vi.fn()}
      />
    </>
  );
}

describe("MarginRail breakpoint", () => {
  it("renders no rail on mobile (the Evidence sheet is the presenter, N-6)", () => {
    render(<MarginRailHarness isMobile />);
    expect(screen.queryByTestId("margin-rail")).not.toBeInTheDocument();
  });
});
