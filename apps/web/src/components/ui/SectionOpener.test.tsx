import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SectionOpener from "./SectionOpener";

describe("SectionOpener", () => {
  it("renders the display heading as the page h1 at the display scale by default", () => {
    render(<SectionOpener heading="Libraries" />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Libraries" });
    expect(h1).toHaveAttribute("data-scale", "display");
  });

  it("supports the detail title scale with a measure-constrained standfirst", () => {
    render(
      <SectionOpener
        heading="Kafka in Action"
        scale="title"
        standfirst="Everything shelved under this library."
      />,
    );
    const h1 = screen.getByRole("heading", { level: 1, name: "Kafka in Action" });
    expect(h1).toHaveAttribute("data-scale", "title");
    expect(
      screen.getByText("Everything shelved under this library."),
    ).toBeInTheDocument();
  });

  it("renders an opener-level action", () => {
    render(
      <SectionOpener
        heading="Libraries"
        actions={<button type="button">New library</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "New library" })).toBeInTheDocument();
  });

  it("keeps an accessible heading name while pending", () => {
    render(<SectionOpener heading="Kafka in Action" pending />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Kafka in Action" });
    expect(h1).toHaveAttribute("aria-busy", "true");
  });
});
