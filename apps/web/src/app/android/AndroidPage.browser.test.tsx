import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { ANDROID_RELEASE_LINKS } from "@/lib/androidReleaseLinks";
import AndroidPage from "./page";

describe("Android release page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects the exact private release narrative and stable links without fetching", () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    render(<AndroidPage />);

    const main = screen.getByRole("main");
    const view = within(main);

    expect(view.getByText("Nexus", { selector: "p" })).toBeVisible();
    expect(view.getByText("A private instrument for attention.")).toBeVisible();
    expect(view.getByText("Private distribution")).toBeVisible();
    expect(
      view.getByRole("heading", { level: 1, name: "Nexus for Android" }),
    ).toBeVisible();
    expect(
      view.getByText("The first-party Android companion for your Nexus library."),
    ).toBeVisible();
    expect(
      view.getByText("GitHub access is required to download this release."),
    ).toBeVisible();
    expect(
      view.getByRole("heading", { level: 2, name: "Verify this release" }),
    ).toBeVisible();
    expect(
      view.getByText(
        "Compare the APK's SHA-256 with the checksum. The release manifest records the source commit, signing-certificate fingerprint, and artifact digests accepted by the release gate.",
      ),
    ).toBeVisible();
    expect(
      view.getByText(
        "Android may ask you to allow installs from this browser. Only install Nexus from this page or its linked GitHub release.",
      ),
    ).toBeVisible();

    const content = main.textContent ?? "";
    let previousPosition = -1;
    for (const phrase of [
      "A private instrument for attention.",
      "Private distribution",
      "Nexus for Android",
      "The first-party Android companion for your Nexus library.",
      "GitHub access is required to download this release.",
      "Download APK",
      "Verify this release",
      "Compare the APK's SHA-256 with the checksum.",
      "SHA-256 checksum",
      "Release manifest",
      "View release on GitHub",
      "Android may ask you to allow installs from this browser.",
      "Open Nexus",
      "Privacy",
      "Terms",
    ]) {
      const position = content.indexOf(phrase, previousPosition + 1);
      expect(position, `${phrase} is absent or out of order`).toBeGreaterThan(
        previousPosition,
      );
      previousPosition = position;
    }

    expect(
      view.getAllByRole<HTMLAnchorElement>("link").map((link) => [
        link.textContent,
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Download APK", ANDROID_RELEASE_LINKS.apk],
      ["SHA-256 checksum", ANDROID_RELEASE_LINKS.checksum],
      ["Release manifest", ANDROID_RELEASE_LINKS.manifest],
      ["View release on GitHub", ANDROID_RELEASE_LINKS.latestRelease],
      ["Open Nexus", "/"],
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
    ]);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
