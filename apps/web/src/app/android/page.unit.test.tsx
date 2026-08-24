import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AndroidPage from "./page";

// Risk: the Update action and the production release gate name different
// APKs. Both must resolve GitHub's canonical `releases/latest` pointer for the
// one repository the deploy controller gates on.

function deployControllerLatestRelease(): string {
  const deploy = readFileSync(
    path.resolve(__dirname, "../../../../../deploy/hetzner/deploy.sh"),
    "utf8",
  );
  const repository = /^readonly REPOSITORY="([^"]+)"$/mu.exec(deploy)?.[1];
  if (repository === undefined) {
    throw new Error("deploy.sh no longer declares its GitHub repository");
  }
  expect(deploy).toContain(`gh api "repos/\${REPOSITORY}/releases/latest"`);
  return `https://github.com/${repository}/releases/latest`;
}

function exactAnchor(label: string, href: string): RegExp {
  const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `<a(?=[^>]*href="${escapedHref}")[^>]*>${label}</a>`,
    "u",
  );
}

describe("Android download page", () => {
  it("links the APK, checksum, and releases to the deploy controller's latest-release owner", () => {
    const latest = deployControllerLatestRelease();

    const view = renderToStaticMarkup(<AndroidPage />);

    expect(view).toMatch(
      exactAnchor("Download APK", `${latest}/download/nexus-android.apk`),
    );
    expect(view).toMatch(
      exactAnchor("Checksum", `${latest}/download/nexus-android.apk.sha256`),
    );
    expect(view).toMatch(exactAnchor("Releases", latest));
  });
});
