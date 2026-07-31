import { readFileSync } from "node:fs";
import path from "node:path";
import type { APIResponse } from "playwright/test";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";

test.use({ journeyId: "durable-ingest-reader-open" });

interface UploadInit {
  data: {
    media_id: string;
    source_attempt_id: string;
    upload_url: string;
  };
}

function uniqueEpub(runIdentity: string): Buffer {
  const source = readFileSync(
    path.resolve(
      __dirname,
      "../../../../python/tests/fixtures/epub/moby-dick-epub3.epub",
    ),
  );
  const endOfCentralDirectory = source.lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  );
  if (endOfCentralDirectory < 0) {
    throw new Error("The canonical Moby Dick EPUB has no ZIP end record.");
  }
  const comment = Buffer.from(`nexus-test:${runIdentity}`, "utf8");
  const archive = Buffer.from(source.subarray(0, endOfCentralDirectory + 22));
  archive.writeUInt16LE(comment.byteLength, endOfCentralDirectory + 20);
  return Buffer.concat([archive, comment]);
}

async function readBody(response: APIResponse) {
  const text = await response.text();
  expect(
    response.ok(),
    `Expected ${response.url()} to succeed; status=${response.status()} body=${text.slice(0, 500)}`,
  ).toBeTruthy();
  return JSON.parse(text) as unknown;
}

test("an accepted EPUB survives worker ingestion and opens in the real reader", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const epub = uniqueEpub(journeyUser.id);
  const initResponse = await page.request.post("/api/media/upload/init", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": `durable-ingest-${journeyUser.id}`,
    },
    data: {
      kind: "epub",
      filename: "moby-dick-durable-ingest.epub",
      content_type: "application/epub+zip",
      size_bytes: epub.byteLength,
      library_ids: [],
    },
  });
  const init = (await readBody(initResponse)) as UploadInit;
  expect(
    init.data.upload_url,
    `Upload init for media ${init.data.media_id} did not publish a local object-store URL.`,
  ).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//);

  const objectResponse = await page.request.put(init.data.upload_url, {
    headers: { "Content-Type": "application/epub+zip" },
    data: epub,
  });
  expect(
    objectResponse.ok(),
    `Local object upload for media ${init.data.media_id} failed with ${objectResponse.status()}.`,
  ).toBeTruthy();

  const confirmResponse = await page.request.post(
    `/api/media/${init.data.media_id}/ingest`,
    {
      headers: { origin: webOrigin },
      data: { library_ids: [] },
    },
  );
  const confirmed = (await readBody(confirmResponse)) as {
    data: {
      media_id: string;
      source_attempt_id: string;
      duplicate: boolean;
      ingest_enqueued: boolean;
    };
  };
  expect(
    confirmed.data,
    `Upload confirmation changed the accepted identity for media ${init.data.media_id}.`,
  ).toMatchObject({
    media_id: init.data.media_id,
    source_attempt_id: init.data.source_attempt_id,
    duplicate: false,
    ingest_enqueued: true,
  });

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/media/${init.data.media_id}`,
        );
        if (!response.ok()) return `http-${response.status()}`;
        const payload = (await response.json()) as {
          data: { processing_status: string };
        };
        return payload.data.processing_status;
      },
      {
        message: `Expected worker-owned media ${init.data.media_id} to reach ready_for_reading.`,
        timeout: 25_000,
      },
    )
    .toBe("ready_for_reading");

  await gotoWithStrictCsp(page, `/media/${init.data.media_id}`);
  await expect(page).toHaveURL(
    new RegExp(`/media/${init.data.media_id}(?:[?#]|$)`),
  );
  await expect(
    page.getByRole("heading", { name: "Moby Dick; Or, The Whale" }),
    `Reader did not project the independently known EPUB title for media ${init.data.media_id}.`,
  ).toBeVisible();
  await expect(
    page.getByRole("toolbar", { name: "EPUB controls" }),
    `Reader for media ${init.data.media_id} did not publish EPUB navigation.`,
  ).toBeVisible();
});
