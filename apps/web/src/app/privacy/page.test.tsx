import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage from "./page";

describe("PrivacyPage", () => {
  it("renders a public privacy policy with the core production disclosures", () => {
    render(<PrivacyPage />);

    expect(screen.getByRole("heading", { name: /privacy policy/i })).toBeVisible();
    expect(
      screen.getByText(/google and github sign-in information/i)
    ).toBeVisible();
    expect(
      screen.getByText(/documents, media, notes, and highlights/i)
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /return to sign in/i })).toHaveAttribute(
      "href",
      "/login"
    );
  });
});
