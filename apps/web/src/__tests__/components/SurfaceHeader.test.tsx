import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SurfaceHeader from "@/components/ui/SurfaceHeader";

describe("SurfaceHeader", () => {
  it("renders title, back control, navigation controls, and options menu", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onDelete = vi.fn();

    render(
      <SurfaceHeader
        title="The Pragmatic Programmer"
        subtitle="pdf"
        back={{ label: "Back to Libraries", onClick: onBack }}
        navigation={{
          label: "Page 8 of 42",
          previous: { label: "Previous page", onClick: onPrev },
          next: { label: "Next page", onClick: onNext },
        }}
        options={[{ id: "delete", label: "Delete", onSelect: onDelete, tone: "danger" }]}
      />
    );

    expect(screen.getByRole("heading", { name: "The Pragmatic Programmer" })).toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to Libraries" }));
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);

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

  it("does not render an inert back control", () => {
    render(<SurfaceHeader title="Reader" back={{ label: "Back to Libraries" }} />);
    expect(screen.queryByRole("button", { name: "Back to Libraries" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back to Libraries" })).not.toBeInTheDocument();
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
});
