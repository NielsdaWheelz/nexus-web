import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPaneBody from "@/app/(authenticated)/settings/SettingsPaneBody";

describe("SettingsPaneBody", () => {
  it("includes linked identities management entrypoint", () => {
    render(<SettingsPaneBody />);

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

  it("hides Local Vault in the Android shell without hiding Billing", () => {
    render(<SettingsPaneBody initialAndroidShell />);

    expect(screen.getByRole("link", { name: /billing/i })).toHaveAttribute(
      "href",
      "/settings/billing"
    );
    expect(screen.queryByRole("link", { name: /local vault/i })).not.toBeInTheDocument();
  });
});
