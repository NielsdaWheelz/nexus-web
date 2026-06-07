import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Chip from "./Chip";

describe("Chip (pressable mode)", () => {
  it("renders a real button exposing aria-pressed", () => {
    render(
      <Chip pressed onPressedChange={() => {}}>
        Documents
      </Chip>,
    );
    const button = screen.getByRole("button", { name: "Documents" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("reflects an unpressed state via aria-pressed", () => {
    render(
      <Chip pressed={false} onPressedChange={() => {}}>
        Notes
      </Chip>,
    );
    expect(screen.getByRole("button", { name: "Notes" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("toggles to the opposite of the current pressed state when clicked", async () => {
    const onPressedChange = vi.fn();
    render(
      <Chip pressed onPressedChange={onPressedChange}>
        Documents
      </Chip>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(onPressedChange).toHaveBeenCalledWith(false);
  });

  it("toggles from unpressed to pressed when clicked", async () => {
    const onPressedChange = vi.fn();
    render(
      <Chip pressed={false} onPressedChange={onPressedChange}>
        Notes
      </Chip>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });

  it("disables the button and suppresses clicks when disabled", async () => {
    const onPressedChange = vi.fn();
    render(
      <Chip pressed={false} disabled onPressedChange={onPressedChange}>
        Notes
      </Chip>,
    );
    const button = screen.getByRole("button", { name: "Notes" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onPressedChange).not.toHaveBeenCalled();
  });

  it("forwards a ref to the underlying button", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Chip ref={ref} pressed onPressedChange={() => {}}>
        Documents
      </Chip>,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("BUTTON");
    expect(ref.current).toBe(screen.getByRole("button", { name: "Documents" }));
  });

  it("spreads extra props (title, data-*) onto the button", () => {
    render(
      <Chip
        pressed={false}
        onPressedChange={() => {}}
        title="Formats apply to documents"
        data-testid="kind-chip"
      >
        Notes
      </Chip>,
    );
    const button = screen.getByRole("button", { name: "Notes" });
    expect(button).toHaveAttribute("title", "Formats apply to documents");
    expect(button).toHaveAttribute("data-testid", "kind-chip");
  });
});

describe("Chip (removable mode)", () => {
  it("renders a non-button chip with a Remove control", () => {
    render(
      <Chip removable onRemove={() => {}}>
        PDFs
      </Chip>,
    );
    // The chip label is plain text inside a <div>, not a button.
    expect(screen.getByText("PDFs")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "PDFs" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("calls onRemove when the Remove control is clicked", async () => {
    const onRemove = vi.fn();
    render(
      <Chip removable onRemove={onRemove}>
        PDFs
      </Chip>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
