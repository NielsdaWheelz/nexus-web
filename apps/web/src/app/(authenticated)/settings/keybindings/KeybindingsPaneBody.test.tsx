import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import KeybindingsPaneBody from "./KeybindingsPaneBody";

describe("KeybindingsPaneBody", () => {
  it("renders Launcher, canonical destinations, and the Today action", () => {
    render(
      <KeybindingsProvider>
        <KeybindingsPaneBody />
      </KeybindingsProvider>,
    );
    expect(screen.getByText("Open launcher")).toBeInTheDocument();
    expect(screen.getByText("Go to Lectern")).toBeInTheDocument();
    expect(screen.getByText("Go to Atlas")).toBeInTheDocument();
    expect(screen.getByText("Go to Today")).toBeInTheDocument();
  });
});
