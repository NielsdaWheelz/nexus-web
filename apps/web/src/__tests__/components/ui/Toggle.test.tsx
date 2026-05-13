import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Toggle from "@/components/ui/Toggle";

function ControlledToggle({
  initial = false,
  disabled = false,
  label = "Enable",
}: {
  initial?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  const [checked, setChecked] = useState(initial);
  return (
    <Toggle
      checked={checked}
      onCheckedChange={setChecked}
      label={label}
      disabled={disabled}
    />
  );
}

describe("Toggle", () => {
  it("renders an unchecked checkbox with the given label", () => {
    render(<ControlledToggle label="Enable feature" />);

    const input = screen.getByRole("checkbox", { name: "Enable feature" });
    expect(input).not.toBeChecked();
    expect(screen.getByText("Enable feature")).toBeInTheDocument();
  });

  it("flips checked state when the user clicks the label", async () => {
    const user = userEvent.setup();
    render(<ControlledToggle label="Enable feature" />);

    const input = screen.getByRole("checkbox", { name: "Enable feature" });
    expect(input).not.toBeChecked();

    await user.click(screen.getByText("Enable feature"));
    expect(input).toBeChecked();

    await user.click(screen.getByText("Enable feature"));
    expect(input).not.toBeChecked();
  });

  it("does not change when disabled", () => {
    const onCheckedChange = vi.fn();

    render(
      <Toggle
        checked={false}
        onCheckedChange={onCheckedChange}
        label="Disabled toggle"
        disabled
      />
    );

    const input = screen.getByRole("checkbox", { name: "Disabled toggle" });
    expect(input).toBeDisabled();
    expect(input).not.toBeChecked();

    // Synthesize a native click on the label. Browsers route this through the
    // disabled input, which suppresses the change event.
    fireEvent.click(screen.getByText("Disabled toggle"));

    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(input).not.toBeChecked();
  });
});
