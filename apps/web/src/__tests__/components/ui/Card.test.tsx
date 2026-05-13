import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Card from "@/components/ui/Card";

describe("Card", () => {
  it("renders children with default bordered + md padding", () => {
    render(<Card data-testid="card">Hello</Card>);
    const el = screen.getByTestId("card");
    expect(el).toHaveTextContent("Hello");
    expect(el.className).toMatch(/bordered/);
    expect(el.className).toMatch(/padMd/);
  });

  it("applies flat variant", () => {
    render(
      <Card data-testid="card" variant="flat">
        body
      </Card>
    );
    expect(screen.getByTestId("card").className).toMatch(/flat/);
  });

  it("applies elevated variant", () => {
    render(
      <Card data-testid="card" variant="elevated">
        body
      </Card>
    );
    expect(screen.getByTestId("card").className).toMatch(/elevated/);
  });

  it("applies each padding step", () => {
    const { rerender } = render(
      <Card data-testid="card" padding="none">
        x
      </Card>
    );
    expect(screen.getByTestId("card").className).toMatch(/padNone/);

    rerender(
      <Card data-testid="card" padding="sm">
        x
      </Card>
    );
    expect(screen.getByTestId("card").className).toMatch(/padSm/);

    rerender(
      <Card data-testid="card" padding="lg">
        x
      </Card>
    );
    expect(screen.getByTestId("card").className).toMatch(/padLg/);
  });

  it("merges custom className", () => {
    render(
      <Card data-testid="card" className="custom-class">
        body
      </Card>
    );
    expect(screen.getByTestId("card").className).toMatch(/custom-class/);
  });

  it("renders as child when asChild is true", () => {
    render(
      <Card asChild>
        <section data-testid="section">section body</section>
      </Card>
    );
    const section = screen.getByTestId("section");
    expect(section.tagName).toBe("SECTION");
    expect(section.className).toMatch(/bordered/);
  });
});
