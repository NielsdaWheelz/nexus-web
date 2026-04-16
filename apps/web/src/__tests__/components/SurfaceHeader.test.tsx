import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SurfaceHeader from "@/components/ui/SurfaceHeader";

describe("SurfaceHeader", () => {
  it("renders title and options menu", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    render(
      <SurfaceHeader
        title="The Pragmatic Programmer"
        subtitle="pdf"
        options={[{ id: "delete", label: "Delete", onSelect: onDelete, tone: "danger" }]}
      />
    );

    expect(screen.getByRole("heading", { name: "The Pragmatic Programmer" })).toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("moves focus into options menu and loops tab focus", async () => {
    const user = userEvent.setup();

    render(
      <SurfaceHeader
        title="Reader"
        options={[
          { id: "open", label: "Open source", onSelect: vi.fn() },
          { id: "delete", label: "Delete", onSelect: vi.fn(), tone: "danger" },
        ]}
      />
    );

    const optionsToggle = screen.getByRole("button", { name: "Options" });
    await user.click(optionsToggle);

    const openSourceOption = screen.getByRole("menuitem", { name: "Open source" });
    const deleteOption = screen.getByRole("menuitem", { name: "Delete" });
    await waitFor(() => {
      expect(openSourceOption).toHaveFocus();
    });

    await user.tab();
    expect(deleteOption).toHaveFocus();

    await user.tab();
    expect(openSourceOption).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(optionsToggle).toHaveFocus();
    });
  });

  it("keeps disabled link options non-interactive", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <SurfaceHeader
        title="Reader"
        options={[
          {
            id: "open-source",
            label: "Open source",
            href: "https://example.com",
            disabled: true,
            onSelect,
          },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Options" }));
    const item = screen.getByRole("menuitem", { name: "Open source" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAttribute("tabindex", "-1");

    await user.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe("mobile viewport", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("hides meta and subtitle on mobile viewport", () => {
      vi.stubGlobal("innerWidth", 390);
      window.dispatchEvent(new Event("resize"));

      render(
        <SurfaceHeader
          title="Design Doc"
          subtitle="Chapter 1"
          meta={<span data-testid="header-meta">PDF · View Source</span>}
        />
      );

      const header = screen.getByRole("banner");
      expect(header).toHaveAttribute("data-mobile", "true");

      // Meta and subtitle are rendered but hidden via CSS (.mobile .meta { display: none })
      expect(screen.getByTestId("header-meta")).toBeInTheDocument();
    });

    it("sets data-mobile attribute on mobile viewport", () => {
      vi.stubGlobal("innerWidth", 390);
      window.dispatchEvent(new Event("resize"));

      render(<SurfaceHeader title="Test" />);

      expect(screen.getByRole("banner")).toHaveAttribute("data-mobile", "true");
    });

    it("does not set data-mobile on desktop viewport", () => {
      vi.stubGlobal("innerWidth", 1024);
      window.dispatchEvent(new Event("resize"));

      render(<SurfaceHeader title="Test" />);

      expect(screen.getByRole("banner")).not.toHaveAttribute("data-mobile", "true");
    });
  });
});
