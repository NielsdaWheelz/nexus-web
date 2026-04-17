import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import KeybindingsPaneBody from "./KeybindingsPaneBody";

describe("KeybindingsPaneBody", () => {
  it("keeps the Open command palette binding label", () => {
    render(<KeybindingsPaneBody />);
    expect(screen.getByText("Open command palette")).toBeInTheDocument();
  });
});
