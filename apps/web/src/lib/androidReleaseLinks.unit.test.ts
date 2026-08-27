import { describe, expect, it } from "vitest";
import { ANDROID_RELEASE_LINKS } from "./androidReleaseLinks";

describe("Android release links", () => {
  it("projects the one private stable release channel as four exact URLs", () => {
    expect(ANDROID_RELEASE_LINKS).toStrictEqual({
      latestRelease:
        "https://github.com/NielsdaWheelz/nexus-web/releases/latest",
      apk: "https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk",
      checksum:
        "https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk.sha256",
      manifest:
        "https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/release-manifest.json",
    });
  });
});
