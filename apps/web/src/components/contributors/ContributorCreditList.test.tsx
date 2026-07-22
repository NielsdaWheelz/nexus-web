import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ContributorCreditList from "./ContributorCreditList";

describe("ContributorCreditList", () => {
  it("renders handle-less preview credits as plain text (D-9)", () => {
    render(
      <ContributorCreditList
        credits={[
          {
            contributor_display_name: "Preview Author",
            credited_name: "Preview Author",
            role: "author",
          },
        ]}
      />,
    );

    expect(screen.getByText("Preview Author")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links credits that carry a handle and shows a comma-separated overflow count", () => {
    render(
      <ContributorCreditList
        maxVisible={2}
        credits={[
          {
            contributor_handle: "ursula-le-guin",
            contributor_display_name: "Ursula K. Le Guin",
            credited_name: "Ursula K. Le Guin",
            role: "author",
            href: "/authors/ursula-le-guin",
          },
          {
            contributor_handle: "octavia-butler",
            contributor_display_name: "Octavia E. Butler",
            credited_name: "Octavia E. Butler",
            role: "author",
            href: "/authors/octavia-butler",
          },
          {
            contributor_handle: "samuel-delany",
            contributor_display_name: "Samuel R. Delany",
            credited_name: "Samuel R. Delany",
            role: "author",
            href: "/authors/samuel-delany",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Ursula K. Le Guin" })).toHaveAttribute(
      "href",
      "/authors/ursula-le-guin",
    );
    expect(screen.getByRole("link", { name: "Octavia E. Butler" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Samuel R. Delany" })).not.toBeInTheDocument();
    expect(screen.getByText(", +1")).toBeVisible();
  });
});
