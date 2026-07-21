import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ContributorChip from "./ContributorChip";

describe("ContributorChip", () => {
  it("links credited contributor chips to the author pane", () => {
    render(
      <ContributorChip
        showRole
        credit={{
          contributor_handle: "ursula-le-guin",
          contributor_display_name: "Ursula K. Le Guin",
          credited_name: "U. K. Le Guin",
          role: "author",
          href: "/authors/ursula-le-guin",
        }}
      />,
    );

    const link = screen.getByRole("link", { name: /U. K. Le Guin/ });
    expect(link).toHaveAttribute("href", "/authors/ursula-le-guin");
    expect(link).toHaveAttribute("data-pane-label-hint", "U. K. Le Guin");
    expect(link).toHaveTextContent("author");
    expect(link).toHaveAttribute("title", "U. K. Le Guin (Ursula K. Le Guin)");
  });

  it("renders a handle-less preview credit as plain text, not a link", () => {
    render(
      <ContributorChip
        credit={{
          contributor_display_name: "Preview Author",
          credited_name: "Preview Author",
          role: "host",
        }}
      />,
    );

    expect(screen.getByText("Preview Author")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("uses contributor handles when rendering contributor summaries", () => {
    render(
      <ContributorChip
        contributor={{
          handle: "octavia-butler",
          display_name: "Octavia E. Butler",
        }}
      />,
    );

    const link = screen.getByRole("link", { name: "Octavia E. Butler" });
    expect(link).toHaveAttribute(
      "href",
      "/authors/octavia-butler",
    );
    expect(link).toHaveAttribute("data-pane-label-hint", "Octavia E. Butler");
  });
});
