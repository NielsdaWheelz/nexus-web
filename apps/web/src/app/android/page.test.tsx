import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AndroidPage from "./page";

describe("AndroidPage", () => {
  it("renders the wordmark, the Android subhead, the APK download, the trust links, and the sign-in escape", () => {
    render(<AndroidPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Nexus" })
    ).toBeVisible();
    expect(screen.getByText("Android")).toBeVisible();

    expect(
      screen.getByRole("link", { name: /download apk/i })
    ).toHaveAttribute(
      "href",
      "https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk"
    );
    expect(screen.getByRole("link", { name: /checksum/i })).toHaveAttribute(
      "href",
      "https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk.sha256"
    );
    expect(screen.getByRole("link", { name: /releases/i })).toHaveAttribute(
      "href",
      "https://github.com/NielsdaWheelz/nexus-web/releases/latest"
    );
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/login"
    );
  });
});
