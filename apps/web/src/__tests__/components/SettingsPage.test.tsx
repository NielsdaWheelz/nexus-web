import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "@/app/(authenticated)/settings/page";

describe("SettingsPage", () => {
  it("includes linked identities management entrypoint", () => {
    render(<SettingsPage />);

    const linkedIdentitiesLink = screen.getByRole("link", {
      name: /linked identities/i,
    });
    expect(linkedIdentitiesLink).toHaveAttribute("href", "/settings/identities");
  });
});
