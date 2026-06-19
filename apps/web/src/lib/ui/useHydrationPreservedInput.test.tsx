import { useLayoutEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHydrationPreservedInput } from "./useHydrationPreservedInput";

function HydrationWindowHarness() {
  const field = useHydrationPreservedInput();

  useLayoutEffect(() => {
    const input = screen.getByRole("textbox", { name: "Name" });
    if (input instanceof HTMLInputElement) {
      input.value = "Typed before hydration settled";
    }
  }, []);

  return (
    <form>
      <input aria-label="Name" {...field.inputProps} />
      <button type="submit" disabled={!field.value.trim()}>
        Create
      </button>
    </form>
  );
}

describe("useHydrationPreservedInput", () => {
  it("reconciles a DOM value preserved before the first client effect", async () => {
    render(<HydrationWindowHarness />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Typed before hydration settled",
    );
  });
});
