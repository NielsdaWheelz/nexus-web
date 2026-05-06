import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Button from "@/components/ui/Button";

describe("Button", () => {
  it("renders with text", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("applies different className per variant", () => {
    const { rerender } = render(<Button variant="primary">A</Button>);
    const primaryClass = screen.getByRole("button").className;

    rerender(<Button variant="secondary">A</Button>);
    const secondaryClass = screen.getByRole("button").className;

    rerender(<Button variant="ghost">A</Button>);
    const ghostClass = screen.getByRole("button").className;

    rerender(<Button variant="danger">A</Button>);
    const dangerClass = screen.getByRole("button").className;

    rerender(<Button variant="pill">A</Button>);
    const pillClass = screen.getByRole("button").className;

    const classes = new Set([
      primaryClass,
      secondaryClass,
      ghostClass,
      dangerClass,
      pillClass,
    ]);
    expect(classes.size).toBe(5);
  });

  it("applies different className per size", () => {
    const { rerender } = render(<Button size="sm">A</Button>);
    const sm = screen.getByRole("button").className;

    rerender(<Button size="md">A</Button>);
    const md = screen.getByRole("button").className;

    rerender(<Button size="lg">A</Button>);
    const lg = screen.getByRole("button").className;

    expect(new Set([sm, md, lg]).size).toBe(3);
  });

  it("reflects disabled state in DOM", () => {
    render(<Button disabled>Click</Button>);
    expect(screen.getByRole("button", { name: "Click" })).toBeDisabled();
  });

  it("disables button and hides label while loading", () => {
    render(<Button loading>Saving</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
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

  it("merges className when asChild renders custom element", () => {
    render(
      <Button asChild>
        <a href="/x" className="extra">
          Link
        </a>
      </Button>
    );
    const link = screen.getByRole("link", { name: "Link" });
    expect(link.className).toContain("extra");
  });
});
