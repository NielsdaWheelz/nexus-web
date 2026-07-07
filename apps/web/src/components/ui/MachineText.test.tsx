import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import MachineText from "./MachineText";

// Sentinel faces so the register/containment assertions are deterministic and
// independent of the Next font loader (which never runs in the test bundle):
// var(--font-machine)/var(--font-sans) resolve to these on the rendered subtree.
const tokenStyle = {
  "--font-machine": "MachineFace",
  "--font-sans": "HumanFace",
  "--rail-machine": "rgba(0, 0, 0, 0.4)",
} as CSSProperties;

describe("MachineText", () => {
  it("block: applies the machine face, the rail, and a signature from provenance", () => {
    render(
      <MachineText
        origin={{ label: "Assistant" }}
        timestamp="06:14"
        timestampIso="2026-06-03T06:14:00Z"
        style={tokenStyle}
        data-testid="mt"
      >
        <p>Machine prose</p>
      </MachineText>,
    );

    const block = screen.getByTestId("mt");
    expect(block.tagName).toBe("DIV");
    expect(block).toHaveAttribute("data-machine-origin", "Assistant");
    // Machine register applied (font resolves to the sentinel machine face).
    expect(getComputedStyle(block).fontFamily).toContain("MachineFace");
    // Left hairline apparatus rail (border-inline-start).
    expect(getComputedStyle(block).borderInlineStartStyle).toBe("solid");

    // Signature = origin + a machine-readable <time> (the "· 06:14" text node
    // is the <time> element; its datetime carries the raw ISO instant — D-9).
    expect(screen.getByText("Assistant")).toBeInTheDocument();
    expect(screen.getByText("· 06:14")).toHaveAttribute(
      "datetime",
      "2026-06-03T06:14:00Z",
    );
  });

  it("block: omitting timestamp renders no <time> (no fabrication)", () => {
    render(
      <MachineText origin={{ label: "Dossier" }} data-testid="mt">
        <p>Body</p>
      </MachineText>,
    );
    expect(screen.getByTestId("mt")).toBeInTheDocument();
    expect(screen.getByText("Dossier")).toBeInTheDocument();
    // No timestamp → no <time> (its text would carry the "· " separator).
    expect(screen.queryByText(/^·/)).not.toBeInTheDocument();
  });

  it("block: showSignature=false suppresses the head but keeps the rail", () => {
    render(
      <MachineText
        origin={{ label: "Assistant" }}
        showSignature={false}
        style={tokenStyle}
        data-testid="mt"
      >
        <p>Body</p>
      </MachineText>,
    );
    const block = screen.getByTestId("mt");
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(block).toHaveAttribute("data-machine-origin", "Assistant");
    expect(getComputedStyle(block).borderInlineStartStyle).toBe("solid");
  });

  it("inline: renders a span with no rail, no signature, but stamps provenance", () => {
    render(
      <MachineText
        variant="inline"
        as="span"
        origin={{ label: "Synapse" }}
        timestamp="06:14"
        timestampIso="2026-06-03T06:14:00Z"
        style={tokenStyle}
        data-testid="mt"
      >
        Both argue X
      </MachineText>,
    );
    const inline = screen.getByTestId("mt");
    expect(inline.tagName).toBe("SPAN");
    expect(inline).toHaveAttribute("data-machine-origin", "Synapse");
    expect(getComputedStyle(inline).fontFamily).toContain("MachineFace");
    expect(getComputedStyle(inline).borderInlineStartStyle).toBe("none");
    // The inline variant renders no <time> and no origin head (D-9).
    expect(screen.queryByText(/^·/)).not.toBeInTheDocument();
    expect(screen.queryByText("Synapse")).not.toBeInTheDocument();
    expect(screen.getByText("Both argue X")).toBeInTheDocument();
  });

  it("control-bleed: a nested control keeps the human sans face (AC-6)", () => {
    render(
      <MachineText origin={{ label: "Assistant" }} style={tokenStyle} data-testid="mt">
        <button type="button">Act</button>
      </MachineText>,
    );
    const block = screen.getByTestId("mt");
    expect(getComputedStyle(block).fontFamily).toContain("MachineFace");
    expect(
      getComputedStyle(screen.getByRole("button", { name: "Act" })).fontFamily,
    ).toContain("HumanFace");
  });

  it("forwards className, data-* and event handlers to the host element", () => {
    const onMouseUp = vi.fn();
    render(
      <MachineText
        origin={{ label: "Assistant" }}
        className="host-class"
        data-testid="mt"
        data-host="yes"
        onMouseUp={onMouseUp}
      >
        <p>Body</p>
      </MachineText>,
    );
    const block = screen.getByTestId("mt");
    expect(block).toHaveAttribute("data-host", "yes");
    expect(block).toHaveClass("host-class");
    fireEvent.mouseUp(block);
    expect(onMouseUp).toHaveBeenCalledTimes(1);
  });
});
