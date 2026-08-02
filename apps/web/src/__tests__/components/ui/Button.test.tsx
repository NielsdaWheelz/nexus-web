import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { cdp, userEvent } from "vitest/browser";
import "@/app/globals.css";
import Button from "@/components/ui/Button";

describe("Button", () => {
  it("renders with text", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("reflects disabled state in DOM", () => {
    render(<Button disabled>Click</Button>);
    expect(screen.getByRole("button", { name: "Click" })).toBeDisabled();
  });

  it("disables button and hides label while loading", () => {
    render(
      <Button loading aria-busy="false">
        Saving
      </Button>,
    );
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });

  it("uses a static activity glyph under reduced motion without changing busy width", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      const view = render(<Button>Save changes</Button>);
      const idleButton = screen.getByRole("button", { name: "Save changes" });
      const idleWidth = idleButton.getBoundingClientRect().width;

      view.rerender(<Button loading>Save changes</Button>);

      const busyButton = screen.getByRole("button", { name: "Save changes" });
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the activity glyph is intentionally decorative and has no accessible query
      const glyph = busyButton.querySelector('span[aria-hidden="true"]');
      expect(busyButton).toHaveAttribute("aria-busy", "true");
      expect(busyButton).toBeDisabled();
      expect(busyButton.getBoundingClientRect().width).toBe(idleWidth);
      expect(glyph).not.toBeNull();
      expect(getComputedStyle(glyph!).animationName).toBe("none");
      expect(getComputedStyle(glyph!, "::before").content).toContain("…");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
  });

  it("invokes onClick when activated", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("receives focus via keyboard navigation", async () => {
    const user = userEvent.setup();
    render(<Button>Focus me</Button>);
    await user.tab();
    expect(screen.getByRole("button", { name: "Focus me" })).toHaveFocus();
  });

  it("renders the child element when asChild is true", () => {
    render(
      <Button asChild>
        <a href="/x">Link</a>
      </Button>
    );
    const link = screen.getByRole("link", { name: "Link" });
    expect(link).toHaveAttribute("href", "/x");
  });
});
