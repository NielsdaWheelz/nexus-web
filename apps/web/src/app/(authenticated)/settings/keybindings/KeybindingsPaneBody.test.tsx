import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import KeybindingsPaneBody from "./KeybindingsPaneBody";

describe("KeybindingsPaneBody", () => {
  it("renders the Open launcher binding label", () => {
    render(
      <KeybindingsProvider>
        <KeybindingsPaneBody />
      </KeybindingsProvider>,
    );
    expect(screen.getByText("Open launcher")).toBeInTheDocument();
  });
});
