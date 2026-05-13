import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPaneBody from "./SettingsPaneBody";

describe("SettingsPaneBody", () => {
  it("hides local vault but keeps billing in the android shell", () => {
    render(<SettingsPaneBody initialAndroidShell />);

    expect(screen.getByText("Billing")).toBeInTheDocument();
    expect(screen.queryByText("Local Vault")).not.toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
    expect(screen.getByText("Reader Settings")).toBeInTheDocument();
    expect(screen.getByText("Linked Identities")).toBeInTheDocument();
  });
});
