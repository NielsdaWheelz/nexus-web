import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Select from "@/components/ui/Select";

describe("Select", () => {
  it("renders options inside the native select", () => {
    render(
      <Select aria-label="fruit">
        <option value="apple">Apple</option>
        <option value="pear">Pear</option>
      </Select>
    );
    const sel = screen.getByLabelText<HTMLSelectElement>("fruit");
    expect(sel.tagName).toBe("SELECT");
    expect(sel.options).toHaveLength(2);
  });

  it("applies different className per size", () => {
    const { rerender } = render(
      <Select size="sm" aria-label="s">
        <option value="a">A</option>
      </Select>
    );
    const sm = screen.getByLabelText("s").className;

    rerender(
      <Select size="md" aria-label="s">
        <option value="a">A</option>
      </Select>
    );
    const md = screen.getByLabelText("s").className;

    rerender(
      <Select size="lg" aria-label="s">
        <option value="a">A</option>
      </Select>
    );
    const lg = screen.getByLabelText("s").className;

    expect(new Set([sm, md, lg]).size).toBe(3);
  });

  it("reflects disabled state in DOM", () => {
    render(
      <Select disabled aria-label="x">
        <option value="a">A</option>
      </Select>
    );
    expect(screen.getByLabelText("x")).toBeDisabled();
  });

  it("changes selected value when user picks an option", async () => {
    const user = userEvent.setup();
    render(
      <Select aria-label="pick" defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>
    );
    const sel = screen.getByLabelText<HTMLSelectElement>("pick");
    await user.selectOptions(sel, "b");
    expect(sel.value).toBe("b");
  });

  it("receives focus via keyboard navigation", async () => {
    const user = userEvent.setup();
    render(
      <Select aria-label="focus">
        <option value="a">A</option>
      </Select>
    );
    await user.tab();
    expect(screen.getByLabelText("focus")).toHaveFocus();
  });
});
