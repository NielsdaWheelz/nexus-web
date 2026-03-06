import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HighlightEditPopover from "@/components/HighlightEditPopover";

describe("HighlightEditPopover", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1200);
    window.dispatchEvent(new Event("resize"));
  });

  it("supports editing and saving an annotation note", async () => {
    const user = userEvent.setup();
    const onAnnotationSave = vi.fn().mockResolvedValue(undefined);

    render(
      <HighlightEditPopover
        highlight={{ id: "hl-1", color: "yellow", annotationBody: "Existing note" }}
        anchorRect={new DOMRect(120, 80, 200, 40)}
        isEditingBounds={false}
        onStartEditBounds={vi.fn()}
        onCancelEditBounds={vi.fn()}
        onColorChange={vi.fn().mockResolvedValue(undefined)}
        onDismiss={vi.fn()}
        onAnnotationSave={onAnnotationSave}
        onAnnotationDelete={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "Annotation note" });
    expect(textbox).toHaveValue("Existing note");

    await user.clear(textbox);
    await user.type(textbox, "Updated note from popover");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(onAnnotationSave).toHaveBeenCalledWith("hl-1", "Updated note from popover");
  });

  it("renders as a mobile sheet without anchored top/left positioning", () => {
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    render(
      <HighlightEditPopover
        highlight={{ id: "hl-2", color: "blue", annotationBody: null }}
        anchorRect={new DOMRect(320, 420, 50, 20)}
        isEditingBounds={false}
        onStartEditBounds={vi.fn()}
        onCancelEditBounds={vi.fn()}
        onColorChange={vi.fn().mockResolvedValue(undefined)}
        onDismiss={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Edit highlight" });
    expect(dialog.style.top).toBe("");
    expect(dialog.style.left).toBe("");
  });

  it("deletes annotation when save is triggered with a blank note", async () => {
    const user = userEvent.setup();
    const onAnnotationSave = vi.fn().mockResolvedValue(undefined);
    const onAnnotationDelete = vi.fn().mockResolvedValue(undefined);

    render(
      <HighlightEditPopover
        highlight={{ id: "hl-3", color: "green", annotationBody: "to remove" }}
        anchorRect={new DOMRect(120, 80, 200, 40)}
        isEditingBounds={false}
        onStartEditBounds={vi.fn()}
        onCancelEditBounds={vi.fn()}
        onColorChange={vi.fn().mockResolvedValue(undefined)}
        onDismiss={vi.fn()}
        onAnnotationSave={onAnnotationSave}
        onAnnotationDelete={onAnnotationDelete}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "Annotation note" });
    await user.clear(textbox);
    await user.type(textbox, "   ");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(onAnnotationDelete).toHaveBeenCalledWith("hl-3");
    expect(onAnnotationSave).not.toHaveBeenCalled();
  });

  it("falls back to save callback when delete callback is unavailable", async () => {
    const user = userEvent.setup();
    const onAnnotationSave = vi.fn().mockResolvedValue(undefined);

    render(
      <HighlightEditPopover
        highlight={{ id: "hl-4", color: "pink", annotationBody: "legacy note" }}
        anchorRect={new DOMRect(120, 80, 200, 40)}
        isEditingBounds={false}
        onStartEditBounds={vi.fn()}
        onCancelEditBounds={vi.fn()}
        onColorChange={vi.fn().mockResolvedValue(undefined)}
        onDismiss={vi.fn()}
        onAnnotationSave={onAnnotationSave}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "Annotation note" });
    await user.clear(textbox);
    await user.type(textbox, " ");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(onAnnotationSave).toHaveBeenCalledWith("hl-4", "");
  });
});
