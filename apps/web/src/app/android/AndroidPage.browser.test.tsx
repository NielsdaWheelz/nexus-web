import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { ANDROID_RELEASE_LINKS } from "@/lib/androidReleaseLinks";
import AndroidPage from "./page";

const APPROVED_ANDROID_CONTENT = [
  "Nexus",
  "A private instrument for attention.",
  "Private distribution",
  "Nexus for Android",
  "The first-party Android companion for your Nexus library.",
  "GitHub access is required to download this release.",
  "Download APK",
  "Verify this release",
  "Compare the APK's SHA-256 with the checksum. The release manifest records the source commit, signing-certificate fingerprint, and artifact digests accepted by the release gate.",
  "SHA-256 checksum",
  "Release manifest",
  "View release on GitHub",
  "Android may ask you to allow installs from this browser. Only install Nexus from this page or its linked GitHub release.",
  "Open Nexus",
  "Privacy",
  "Terms",
] as const;

describe("Android release page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects only the approved private release narrative and stable links without fetching", () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    render(<AndroidPage />);

    const main = screen.getByRole("main");
    const view = within(main);

    expect(
      view.getByRole("heading", { level: 1, name: "Nexus for Android" }),
    ).toBeVisible();
    expect(
      view.getByRole("heading", { level: 2, name: "Verify this release" }),
    ).toBeVisible();
    expect(
      view
        .getAllByText(/\S/u, { selector: "p, h1, h2, a" })
        .map((element) =>
          (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
        ),
      "the Android colophon must contain exactly the approved content fields and no added version, date, commit, signature, or health claim",
    ).toEqual(APPROVED_ANDROID_CONTENT);

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
