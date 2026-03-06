import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SplitSurface from "@/components/workspace/SplitSurface";
import Pane from "@/components/Pane";

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

  it("marks primary wrapper with layout role for mobile width targeting", () => {
    render(
      <SplitSurface
        primary={<div>Primary</div>}
        secondary={<div>Secondary</div>}
        secondaryFabLabel="Context"
      />
    );

    const primary = screen.getByText("Primary").closest(
      '[data-split-role="primary"]'
    );
    expect(
      primary,
      "Expected primary wrapper to have data-split-role='primary' for mobile layout CSS targeting"
    ).not.toBeNull();
  });

  describe("pane header deduplication in mobile overlay", () => {
    it("shows only one heading when Pane with title is rendered in mobile overlay", async () => {
      const user = userEvent.setup();
      render(
        <SplitSurface
          primary={<div>Primary</div>}
          secondary={
            <Pane title="Highlights">
              <div>Highlight items</div>
            </Pane>
          }
          secondaryTitle="Highlights"
          secondaryFabLabel="Highlights"
        />
      );

      await user.click(screen.getByRole("button", { name: "Highlights" }));

      const dialog = screen.getByRole("dialog", { name: "Highlights" });
      const headings = within(dialog).getAllByRole("heading", { name: "Highlights" });
      expect(headings).toHaveLength(1);
    });

    it("preserves Pane chrome header in the desktop side-by-side view", () => {
      const { container } = render(
        <SplitSurface
          primary={<div>Primary</div>}
          secondary={
            <Pane title="Highlights">
              <div>Highlight items</div>
            </Pane>
          }
          secondaryTitle="Highlights"
          secondaryFabLabel="Highlights"
        />
      );

      // The desktop aside is CSS-hidden in a mobile viewport but still rendered in DOM.
      // Verify the Pane chrome is present in the DOM for the desktop layout.
      const desktopAside = container.querySelector(
        '[data-split-role="secondary-desktop"]'
      );
      expect(desktopAside).not.toBeNull();
      expect(desktopAside!.querySelector('[data-pane-chrome="true"]')).not.toBeNull();
    });

    it("suppresses Pane chrome inside overlay but not Pane content", async () => {
      const user = userEvent.setup();
      render(
        <SplitSurface
          primary={<div>Primary</div>}
          secondary={
            <Pane title="Highlights">
              <div>Highlight items</div>
            </Pane>
          }
          secondaryTitle="Highlights"
          secondaryFabLabel="Highlights"
        />
      );

      await user.click(screen.getByRole("button", { name: "Highlights" }));

      const dialog = screen.getByRole("dialog", { name: "Highlights" });
      // Content should still be rendered
      expect(within(dialog).getByText("Highlight items")).toBeInTheDocument();
      // Pane chrome should NOT be inside the overlay
      expect(dialog.querySelector('[data-pane-chrome="true"]')).toBeNull();
    });

    it("keeps only overlay heading when Pane title differs from secondaryTitle", async () => {
      const user = userEvent.setup();
      render(
        <SplitSurface
          primary={<div>Primary</div>}
          secondary={
            <Pane title="Pane title">
              <div>Highlight items</div>
            </Pane>
          }
          secondaryTitle="Overlay title"
          secondaryFabLabel="Highlights"
        />
      );

      await user.click(screen.getByRole("button", { name: "Highlights" }));

      const dialog = screen.getByRole("dialog", { name: "Overlay title" });
      const headings = within(dialog).getAllByRole("heading");
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent("Overlay title");
    });
  });
});
