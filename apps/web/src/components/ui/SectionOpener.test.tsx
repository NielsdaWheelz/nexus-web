import type { CSSProperties } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SectionOpener from "./SectionOpener";

describe("SectionOpener", () => {
  it("renders the display heading as the page h1 at the display scale by default", () => {
    render(<SectionOpener heading="Libraries" />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Libraries" });
    expect(h1).toHaveAttribute("data-scale", "display");
  });

  it("steps display headings down only when their primary pane is narrow", () => {
    render(
      <>
        <div
          style={{
            container: "primaryPane / inline-size",
            width: "34rem",
            "--text-display-1": "40px",
            "--text-2xl": "24px",
          } as CSSProperties}
        >
          <SectionOpener heading="Narrow pane" />
        </div>
        <div
          style={{
            container: "primaryPane / inline-size",
            width: "35rem",
            "--text-display-1": "40px",
            "--text-2xl": "24px",
          } as CSSProperties}
        >
          <SectionOpener heading="Comfortable pane" />
        </div>
      </>,
    );

    expect(
      getComputedStyle(
        screen.getByRole("heading", { level: 1, name: "Narrow pane" }),
      ).fontSize,
    ).toBe("24px");
    expect(
      getComputedStyle(
        screen.getByRole("heading", { level: 1, name: "Comfortable pane" }),
      ).fontSize,
    ).toBe("40px");
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
