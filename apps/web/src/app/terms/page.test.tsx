import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TermsPage from "./page";

describe("TermsPage", () => {
  it("renders public terms of service with acceptable-use expectations", () => {
    render(<TermsPage />);

    expect(
      screen.getByRole("heading", { name: /terms of service/i })
    ).toBeVisible();
    expect(
      screen.getByText(/do not use nexus to violate the law/i)
    ).toBeVisible();
    expect(
      screen.getByText(/you remain responsible for the content/i)
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /return to sign in/i })).toHaveAttribute(
      "href",
      "/login"
    );
  });
});
