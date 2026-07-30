import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayerKeyboardShortcuts } from "@/lib/player/usePlayerKeyboardShortcuts";

const commands = {
  play: vi.fn(),
  pause: vi.fn(),
  onSkipBackward: vi.fn(),
  onSkipForward: vi.fn(),
  onPrevious: vi.fn(),
  onNext: vi.fn(),
};

function Harness({
  enabled = true,
  isPlaying = false,
}: {
  enabled?: boolean;
  isPlaying?: boolean;
}) {
  usePlayerKeyboardShortcuts({ enabled, isPlaying, ...commands });
  return (
    <>
      <button type="button">Button</button>
      <a href="/lectern">Link</a>
      <input aria-label="Seek" type="range" />
      <input aria-label="Notes" />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Workspace control"
        aria-valuenow={1}
      />
      <div data-player-shortcuts-disabled>
        <span tabIndex={-1}>Disabled scope</span>
      </div>
    </>
  );
}

function expectNoCommand(): void {
  for (const command of Object.values(commands)) {
    expect(command).not.toHaveBeenCalled();
  }
}

describe("usePlayerKeyboardShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("owns only the documented transport keys", () => {
    const { rerender } = render(<Harness />);

    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(commands.play).toHaveBeenCalledTimes(1);

    rerender(<Harness isPlaying />);
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(commands.pause).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(document, { key: "ArrowRight", shiftKey: true });

    expect(commands.onSkipBackward).toHaveBeenCalledTimes(1);
    expect(commands.onSkipForward).toHaveBeenCalledTimes(1);
    expect(commands.onPrevious).toHaveBeenCalledTimes(1);
    expect(commands.onNext).toHaveBeenCalledTimes(1);
  });

  it("ignores an already-handled event", () => {
    render(<Harness />);
    const event = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);
    expectNoCommand();
  });

  it.each([
    ["Button", () => screen.getByRole("button", { name: "Button" })],
    ["Link", () => screen.getByRole("link", { name: "Link" })],
    ["range", () => screen.getByRole("slider", { name: "Seek" })],
    ["editable", () => screen.getByRole("textbox", { name: "Notes" })],
    [
      "ARIA workspace control",
      () => screen.getByRole("slider", { name: "Workspace control" }),
    ],
    ["disabled scope", () => screen.getByText("Disabled scope")],
  ])("does not steal keys from %s", (_label, target) => {
    render(<Harness />);
    fireEvent.keyDown(target(), { key: "ArrowRight" });
    expectNoCommand();
  });

  it.each([
    { key: " ", code: "Space", shiftKey: true },
    { key: "ArrowLeft", altKey: true },
    { key: "ArrowRight", ctrlKey: true },
    { key: "ArrowRight", metaKey: true },
  ])("ignores unsupported modifier chords: $key", (init) => {
    render(<Harness />);
    fireEvent.keyDown(document, init);
    expectNoCommand();
  });

  it("reads the latest enabled state without replacing its listener", () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const { rerender } = render(<Harness enabled={false} />);
    const listener = addEventListener.mock.calls.find(
      ([type]) => type === "keydown",
    )?.[1];

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expectNoCommand();

    rerender(<Harness />);
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(commands.onSkipBackward).toHaveBeenCalledTimes(1);
    expect(
      addEventListener.mock.calls.filter(
        ([type, candidate]) => type === "keydown" && candidate === listener,
      ),
    ).toHaveLength(1);
  });
});
