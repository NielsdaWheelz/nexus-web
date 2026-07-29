import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DesktopNexusInput from "./DesktopNexusInput";
import type { DesktopNexusController } from "./types";

function controller(
  overrides: Partial<DesktopNexusController> = {},
): DesktopNexusController {
  return {
    open: true,
    page: { kind: "Find" },
    query: "",
    entries: [
      { key: "pane:one", label: "One", icon: null, hasSecondaryActions: false },
      { key: "pane:two", label: "Two", icon: null, hasSecondaryActions: true },
    ],
    activeEntryKey: "pane:one",
    activeWebResultId: null,
    failures: new Set(),
    busy: false,
    focusKey: "Find",
    setQuery: vi.fn(),
    setWebQuery: vi.fn(),
    setActiveEntry: vi.fn(),
    setActiveWebResult: vi.fn(),
    selectEntry: vi.fn(),
    openActions: vi.fn(),
    runAction: vi.fn(),
    selectWebResult: vi.fn(),
    retry: vi.fn(),
    back: vi.fn(),
    escape: vi.fn(),
    shouldSuppressReturnFocusOnClose: () => false,
    ...overrides,
  };
}

describe("DesktopNexusInput", () => {
  it("keeps focus on the combobox while Arrow keys move the active result", () => {
    const value = controller();
    render(<DesktopNexusInput controller={value} />);
    const input = screen.getByRole("combobox", { name: "Find anything" });

    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(value.setActiveEntry).toHaveBeenCalledWith("pane:two");
    expect(input).toHaveFocus();
  });

  it("uses Follow for Enter and Fork for Shift+Enter", () => {
    const value = controller();
    render(<DesktopNexusInput controller={value} />);
    const input = screen.getByRole("combobox", { name: "Find anything" });

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(value.selectEntry).toHaveBeenNthCalledWith(
      1,
      "pane:one",
      "Follow",
      "Keyboard",
    );
    expect(value.selectEntry).toHaveBeenNthCalledWith(
      2,
      "pane:one",
      "Fork",
      "Keyboard",
    );
  });

  it("leaves IME Enter untouched", () => {
    const value = controller();
    render(<DesktopNexusInput controller={value} />);
    const input = screen.getByRole("combobox", { name: "Find anything" });

    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });

    expect(value.selectEntry).not.toHaveBeenCalled();
  });

  it("leaves composing Enter and Home/End with the text input", () => {
    const value = controller();
    render(<DesktopNexusInput controller={value} />);
    const input = screen.getByRole("combobox", { name: "Find anything" });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Home" });
    fireEvent.keyDown(input, { key: "End" });

    expect(value.selectEntry).not.toHaveBeenCalled();
    expect(value.setActiveEntry).not.toHaveBeenCalled();
  });
});
