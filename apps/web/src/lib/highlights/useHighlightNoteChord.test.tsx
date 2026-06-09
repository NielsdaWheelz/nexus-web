import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHighlightNoteChord } from "@/lib/highlights/useHighlightNoteChord";

function Host({ enabled, onTrigger }: { enabled: boolean; onTrigger: () => void }) {
  useHighlightNoteChord({ enabled, onTrigger });
  return (
    <>
      <textarea aria-label="Plain text" />
      <div aria-label="Rich text" contentEditable role="textbox" tabIndex={0} />
    </>
  );
}

describe("useHighlightNoteChord", () => {
  it("fires once and prevents default on bare n while enabled", () => {
    const onTrigger = vi.fn();
    render(<Host enabled onTrigger={onTrigger} />);

    // fireEvent returns false when the handler called preventDefault.
    const notPrevented = fireEvent.keyDown(document.body, { key: "n" });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("does not fire while typing in a textarea or contenteditable", () => {
    const onTrigger = vi.fn();
    render(<Host enabled onTrigger={onTrigger} />);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Plain text" }), { key: "n" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rich text" }), { key: "n" });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("does not fire with meta, ctrl, or shift modifiers", () => {
    const onTrigger = vi.fn();
    render(<Host enabled onTrigger={onTrigger} />);

    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "N", shiftKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("does not fire when disabled", () => {
    const onTrigger = vi.fn();
    render(<Host enabled={false} onTrigger={onTrigger} />);

    fireEvent.keyDown(document.body, { key: "n" });

    expect(onTrigger).not.toHaveBeenCalled();
  });
});
