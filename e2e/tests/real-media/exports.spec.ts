import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

test("@real-media vault export includes block-derived article source text", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const needle = seed.fixtures.web.needle;

  await page.goto("/settings/local-vault");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("nexus-vault.zip");
  const zipPath = testInfo.outputPath("nexus-vault.zip");
  await download.saveAs(zipPath);

  const inspected = spawnSync(
    process.env.PYTHON ?? "python3",
    [
      "-c",
      `
import json
import sys
import zipfile

zip_path, needle = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as archive:
    names = sorted(archive.namelist())
    canonical = None
    for name in names:
        if name.startswith("Sources/") and name.endswith("/canonical.txt"):
            content = archive.read(name).decode("utf-8")
            if needle in content:
                canonical = {"path": name, "content_length": len(content)}
                if "lorem ipsum" in content.lower():
                    raise SystemExit("downloaded canonical source contains lorem ipsum")
                break
    if canonical is None:
        raise SystemExit("downloaded vault is missing the expected canonical source")
    print(json.dumps({"canonical": canonical, "file_count": len(names)}))
`,
      zipPath,
      needle,
    ],
    { encoding: "utf-8" },
  );
  expect(inspected.status, inspected.stderr || inspected.stdout).toBe(0);
  const downloadedVault = JSON.parse(inspected.stdout);

  const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
  expect(
    mediaResponse.ok(),
    `web media ${mediaId} should still be readable`,
  ).toBeTruthy();

  writeRealMediaTrace(testInfo, "real-media-export-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    needle,
    downloaded_filename: download.suggestedFilename(),
    exported_path: downloadedVault.canonical.path,
    exported_content_length: downloadedVault.canonical.content_length,
    exported_file_count: downloadedVault.file_count,
  });
});
