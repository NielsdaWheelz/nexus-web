import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const headersMock = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

import SettingsPage from "./page";

describe("SettingsPage Android shell detection", () => {
  it("uses the request user-agent to hide Local Vault in the Android shell", async () => {
    headersMock.mockResolvedValue(
      new Headers({ "user-agent": `Mozilla/5.0 ${ANDROID_SHELL_USER_AGENT_TOKEN}` })
    );

    render(await SettingsPage());

    expect(screen.getByRole("link", { name: /billing/i })).toHaveAttribute(
      "href",
      "/settings/billing"
    );
    expect(screen.queryByRole("link", { name: /local vault/i })).not.toBeInTheDocument();
  });
});
