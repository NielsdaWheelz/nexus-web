import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Kbd from "@/components/ui/Kbd";

describe("Kbd", () => {
  it("renders content with default ghost variant and sm size", () => {
    render(<Kbd data-testid="kbd">Cmd</Kbd>);
    const el = screen.getByTestId("kbd");
    expect(el).toHaveTextContent("Cmd");
    expect(el.className).toMatch(/ghost/);
    expect(el.className).toMatch(/sizeSm/);
  });

  it("applies bordered variant", () => {
    render(
      <Kbd data-testid="kbd" variant="bordered">
        K
      </Kbd>
    );
    expect(screen.getByTestId("kbd").className).toMatch(/bordered/);
  });

  it("applies md size", () => {
    render(
      <Kbd data-testid="kbd" size="md">
        K
      </Kbd>
    );
    expect(screen.getByTestId("kbd").className).toMatch(/sizeMd/);
  });
});
