import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import KeybindingsPaneBody from "./KeybindingsPaneBody";

describe("KeybindingsPaneBody", () => {
  it("keeps the Open command palette binding label", () => {
    render(
      <KeybindingsProvider>
        <KeybindingsPaneBody />
      </KeybindingsProvider>,
    );
    expect(screen.getByText("Open command palette")).toBeInTheDocument();
  });
});
