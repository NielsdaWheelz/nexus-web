import { readFileSync } from "node:fs";
import path from "node:path";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";

test.use({ journeyId: "reader-progress-resume" });

async function uploadCanonicalEpub(
  page: Parameters<typeof signIn>[0],
  userId: string,
): Promise<string> {
  const epub = readFileSync(
    path.resolve(
      __dirname,
      "../../../../python/tests/fixtures/epub/moby-dick-epub3.epub",
    ),
  );
  const initResponse = await page.request.post("/api/media/upload/init", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": `reader-progress-${userId}`,
    },
    data: {
      kind: "epub",
      filename: "moby-dick-reader-progress.epub",
      content_type: "application/epub+zip",
      size_bytes: epub.byteLength,
      library_ids: [],
    },
  });
  const initText = await initResponse.text();
  expect(
    initResponse.ok(),
    `Reader fixture acceptance failed: ${initResponse.status()} ${initText.slice(0, 500)}`,
  ).toBeTruthy();
  const init = (JSON.parse(initText) as {
    data: { media_id: string; upload_url: string | null };
  }).data;
  if (init.upload_url) {
    const upload = await page.request.put(init.upload_url, {
      headers: { "Content-Type": "application/epub+zip" },
      data: epub,
    });
    expect(
      upload.ok(),
      `Local EPUB object upload for ${init.media_id} failed with ${upload.status()}.`,
    ).toBeTruthy();
    const confirm = await page.request.post(`/api/media/${init.media_id}/ingest`, {
      headers: { origin: webOrigin },
      data: { library_ids: [] },
    });
    expect(
      confirm.ok(),
      `EPUB confirmation for ${init.media_id} failed: ${confirm.status()} ${await confirm.text()}`,
    ).toBeTruthy();
  }
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/media/${init.media_id}`);
        if (!response.ok()) return `http-${response.status()}`;
        return ((await response.json()) as {
          data: { processing_status: string };
        }).data.processing_status;
      },
      {
        message: `Expected EPUB ${init.media_id} to become readable before progress movement.`,
        timeout: 25_000,
      },
    )
    .toBe("ready_for_reading");
  return init.media_id;
}

test("reader section movement persists and resumes on a fresh document", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const mediaId = await uploadCanonicalEpub(page, journeyUser.id);
  const navigationResponse = await page.request.get(
    `/api/media/${mediaId}/navigation`,
  );
  const navigationText = await navigationResponse.text();
  expect(
    navigationResponse.ok(),
    `EPUB navigation for ${mediaId} failed: ${navigationResponse.status()} ${navigationText.slice(0, 500)}`,
  ).toBeTruthy();
  const sections = (
    JSON.parse(navigationText) as {
      data: {
        sections: Array<{
          section_id: string;
          label: string;
          href_path: string | null;
        }>;
      };
    }
  ).data.sections.filter((section) => section.href_path !== null);
  const target = sections.find(
    (section) => section.label === "CHAPTER 1. Loomings.",
  );
  expect(
    target,
    `EPUB ${mediaId} did not expose the fixture-owned Loomings section.`,
  ).toBeDefined();

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const sectionPicker = page.getByLabel("Select section");
  await expect(sectionPicker).toBeVisible();
  await sectionPicker.selectOption(target!.section_id);
  await expect(
    page.getByRole("heading", { name: target!.label, exact: true }),
    `Reader did not render selected section ${target!.section_id} (${target!.label}).`,
  ).toBeVisible();
  await expect(
    page.getByText(/Call me Ishmael\. Some years ago/).first(),
    `Reader section ${target!.section_id} omitted the fixture-owned opening sentence.`,
  ).toBeVisible();

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/media/${mediaId}/reader-state`,
        );
        if (!response.ok()) return `http-${response.status()}`;
        const snapshot = (await response.json()) as {
          data:
            | { state: "Empty" }
            | {
                state: "Positioned";
                locator: {
                  kind: string;
                  target?: { section_id?: string };
                };
              };
        };
        return snapshot.data.state === "Positioned" &&
          snapshot.data.locator.kind === "epub"
          ? snapshot.data.locator.target?.section_id
          : null;
      },
      {
        message: `Expected reader movement for ${mediaId} to persist section ${target!.section_id}.`,
        timeout: 15_000,
      },
    )
    .toBe(target!.section_id);

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(
    page.getByRole("heading", { name: target!.label, exact: true }),
    `Fresh reader document for ${mediaId} did not resume section ${target!.section_id}.`,
  ).toBeVisible();
  const resumedSectionPicker = page.getByLabel("Select section");
  await expect(resumedSectionPicker).toHaveValue(target!.section_id);
  await expect(
    page.getByText(/Call me Ishmael\. Some years ago/).first(),
    `Fresh reader document for ${mediaId} resumed the label but not the Loomings content.`,
  ).toBeVisible();
});
