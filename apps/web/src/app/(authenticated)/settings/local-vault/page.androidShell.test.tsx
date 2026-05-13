import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const headersMock = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

import SettingsLocalVaultPage from "./page";

describe("SettingsLocalVaultPage Android shell detection", () => {
  it("uses the request user-agent to block direct Local Vault access", async () => {
    headersMock.mockResolvedValue(
      new Headers({ "user-agent": `Mozilla/5.0 ${ANDROID_SHELL_USER_AGENT_TOKEN}` })
    );

    render(await SettingsLocalVaultPage());

    expect(
      screen.getByText(
        "Local Vault is not available in the Android app. Use a supported desktop browser to connect and sync a local folder."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect folder/i })).not.toBeInTheDocument();
  });
});
