import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AndroidPage from "./page";

const RELEASE_URL =
  "https://github.com/NielsdaWheelz/nexus-web/releases/latest";

function exactAnchor(label: string, href: string): RegExp {
  const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `<a(?=[^>]*href="${escapedHref}")[^>]*>${label}</a>`,
    "u",
  );
}

describe("Android download page", () => {
  it("renders the exact GitHub latest APK, checksum, and release links", () => {
    const view = renderToStaticMarkup(<AndroidPage />);

    expect(view).toMatch(
      exactAnchor(
        "Download APK",
        `${RELEASE_URL}/download/nexus-android.apk`,
      ),
    );
    expect(view).toMatch(
      exactAnchor(
        "Checksum",
        `${RELEASE_URL}/download/nexus-android.apk.sha256`,
      ),
    );
    expect(view).toMatch(exactAnchor("Releases", RELEASE_URL));
  });
});
