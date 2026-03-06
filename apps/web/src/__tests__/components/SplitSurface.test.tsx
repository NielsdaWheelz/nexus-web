import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SplitSurface from "@/components/workspace/SplitSurface";

describe("SplitSurface", () => {
  it("renders only primary content when secondary is missing", () => {
    render(<SplitSurface primary={<div>Primary</div>} />);
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open context/i })).not.toBeInTheDocument();
  });

  it("opens and closes mobile secondary overlay via floating button", async () => {
    const user = userEvent.setup();
    render(
      <SplitSurface
        primary={<div>Primary</div>}
        secondary={<div>Secondary content</div>}
        secondaryTitle="Linked items"
        secondaryFabLabel="Context"
      />
    );

    const fab = screen.getByRole("button", { name: "Context" });
    expect(fab).toHaveAttribute("aria-expanded", "false");
    await user.click(fab);

    const dialog = screen.getByRole("dialog", { name: "Linked items" });
    expect(fab).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Secondary content")).toBeInTheDocument();

    await user.click(fab);
    expect(screen.queryByRole("dialog", { name: "Linked items" })).not.toBeInTheDocument();
    expect(fab).toHaveAttribute("aria-expanded", "false");
  });

  it("supports escape/backdrop close and restores body overflow", async () => {
    const user = userEvent.setup();
    render(
      <SplitSurface
        primary={<div>Primary</div>}
        secondary={<div>Secondary content</div>}
        secondaryTitle="Linked items"
        secondaryFabLabel="Context"
      />
    );

    const fab = screen.getByRole("button", { name: "Context" });
    await user.click(fab);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Linked items" })).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("");
    });

    await user.click(fab);
    const dialog = screen.getByRole("dialog", { name: "Linked items" });
    const backdrop = dialog.parentElement as HTMLElement;
    await user.click(backdrop);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Linked items" })).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("");
    });
  });

  it("renders both desktop panes side-by-side when secondary exists", () => {
    render(
      <SplitSurface
        primary={<div>Primary</div>}
        secondary={<div>Secondary content</div>}
        secondaryTitle="Linked items"
        secondaryFabLabel="Context"
      />
    );

    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.getByText("Secondary content")).toBeInTheDocument();
  });
});
