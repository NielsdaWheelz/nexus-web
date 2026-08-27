const LATEST_ANDROID_RELEASE =
  "https://github.com/NielsdaWheelz/nexus-web/releases/latest";

export const ANDROID_RELEASE_LINKS = {
  latestRelease: LATEST_ANDROID_RELEASE,
  apk: `${LATEST_ANDROID_RELEASE}/download/nexus-android.apk`,
  checksum: `${LATEST_ANDROID_RELEASE}/download/nexus-android.apk.sha256`,
  manifest: `${LATEST_ANDROID_RELEASE}/download/release-manifest.json`,
} as const;
