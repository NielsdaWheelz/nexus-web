import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DawnWriteBlock from "./DawnWriteBlock";

const BASE_WRITE = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  body_md: "Three chapters of *Montaigne* annotated in two hours.",
  generated_at: "2026-07-08T06:14:00.000Z",
  dismissed_at: null,
};

describe("DawnWriteBlock", () => {
  it("renders with data-testid and data-machine-origin=Dawn", () => {
    render(<DawnWriteBlock write={BASE_WRITE} />);

    expect(screen.getByTestId("dawn-write-block")).toBeInTheDocument();
    const machineEl = screen.getByTestId("dawn-write-machine");
    expect(machineEl).toHaveAttribute("data-machine-origin", "Dawn");
  });

  it("renders the DAWN signature with a time element carrying the ISO datetime", () => {
    render(<DawnWriteBlock write={BASE_WRITE} />);

    // The MachineText signature renders the label
    expect(screen.getByText("Dawn")).toBeInTheDocument();
    // The <time> element's text content begins with "·" and its datetime attribute
    // carries the raw ISO instant (D-9 from machine-hand spec)
    const timeEl = screen.getByText(/^·/);
    expect(timeEl).toHaveAttribute("dateTime", BASE_WRITE.generated_at);
  });

  it("renders the body_md content through MarkdownMessage", () => {
    render(<DawnWriteBlock write={BASE_WRITE} />);

    // body_md rendered as markdown — the em-wrapped word should appear
    expect(screen.getByTestId("dawn-write-block")).toHaveTextContent("Montaigne");
  });

  it("dismiss button click unmounts the block optimistically", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    render(<DawnWriteBlock write={BASE_WRITE} />);
    expect(screen.getByTestId("dawn-write-block")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss dawn write" }));

    expect(screen.queryByTestId("dawn-write-block")).not.toBeInTheDocument();
  });

  it("renders nothing for an already-dismissed write", () => {
    const dismissed = { ...BASE_WRITE, dismissed_at: "2026-07-08T06:20:00.000Z" };
    const { container } = render(<DawnWriteBlock write={dismissed} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("dismiss button is outside the MachineText wrapper (control-bleed)", () => {
    render(<DawnWriteBlock write={BASE_WRITE} />);

    const machineEl = screen.getByTestId("dawn-write-machine");
    // The dismiss button must not be a descendant of the machine element
    expect(
      within(machineEl).queryByRole("button", { name: "Dismiss dawn write" }),
    ).not.toBeInTheDocument();
    // But it should exist in the overall document
    expect(screen.getByRole("button", { name: "Dismiss dawn write" })).toBeInTheDocument();
  });
});
