import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "@/app/(authenticated)/settings/page";

describe("SettingsPage", () => {
  it("includes linked identities management entrypoint", () => {
    render(<SettingsPage />);

    const billingLink = screen.getByRole("link", {
      name: /billing/i,
    });
    expect(billingLink).toHaveAttribute("href", "/settings/billing");

    const linkedIdentitiesLink = screen.getByRole("link", {
      name: /linked identities/i,
    });
    expect(linkedIdentitiesLink).toHaveAttribute("href", "/settings/identities");

    const localVaultLink = screen.getByRole("link", {
      name: /local vault/i,
    });
    expect(localVaultLink).toHaveAttribute("href", "/settings/local-vault");
  });
});
