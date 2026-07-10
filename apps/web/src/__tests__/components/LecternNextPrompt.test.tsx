import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import LecternNextPrompt from "@/components/LecternNextPrompt";

describe("LecternNextPrompt", () => {
  it("renders one quiet 'Next on the lectern' line with the next title", () => {
    render(<LecternNextPrompt title="The Sequel" onSelect={() => {}} />);
    const button = screen.getByRole("button", { name: /Next on the lectern/ });
    expect(button).toHaveTextContent("Next on the lectern: The Sequel");
  });

  it("invokes onSelect exactly once on tap (explicit, never auto-advance)", () => {
    const onSelect = vi.fn();
    render(<LecternNextPrompt title="The Sequel" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Next on the lectern/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
