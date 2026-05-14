import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AndroidPage from "./page";

describe("AndroidPage", () => {
  it("renders the public Android install links and sideload guidance", () => {
    render(<AndroidPage />);

    expect(
      screen.getByRole("heading", { name: /install nexus on android/i })
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /download apk/i })).toHaveAttribute(
      "href",
      "https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk"
    );
    expect(
      screen.getByRole("link", { name: /view sha-256 checksum/i })
    ).toHaveAttribute(
      "href",
      "https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk.sha256"
    );
    expect(
      screen.getByRole("link", { name: /latest github release/i })
    ).toHaveAttribute(
      "href",
      "https://github.com/NielsdaWheelz/nexus-web/releases/latest"
    );
    expect(
      screen.getByText(/allow installs from your browser or file manager/i)
    ).toBeVisible();
    expect(
      screen.getByText(/ordinary web updates are delivered from the server/i)
    ).toBeVisible();
  });
});
