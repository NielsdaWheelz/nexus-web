import { randomUUID } from "node:crypto";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";

test.use({ journeyId: "resource-share-boundary" });

const SOURCE_URL =
  "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/";

test("a link grant exposes only its read-only resource and does not mint an account session", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const sourceResponse = await page.request.post("/api/media/from-url", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": `shared-source-${randomUUID()}`,
    },
    data: { url: SOURCE_URL, library_ids: [] },
  });
  const sourceText = await sourceResponse.text();
  expect(
    sourceResponse.ok(),
    `Shared source acceptance failed: ${sourceResponse.status()} ${sourceText.slice(0, 500)}`,
  ).toBeTruthy();
  const mediaId = (JSON.parse(sourceText) as { data: { media_id: string } })
    .data.media_id;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/media/${mediaId}`);
        if (!response.ok()) return `http-${response.status()}`;
        const media = (await response.json()) as {
          data: {
            processing_status: string;
            retrieval_status: string | null;
          };
        };
        return `${media.data.processing_status}:${media.data.retrieval_status}`;
      },
      {
        message: `Expected media ${mediaId} to become publicly projectable before link creation.`,
        timeout: 25_000,
      },
    )
    .toBe("ready_for_reading:ready");

  const shareResponse = await page.request.post(
    `/api/resource-items/${encodeURIComponent(`media:${mediaId}`)}/shares`,
    {
      headers: { origin: webOrigin },
      data: { audience: { kind: "Link" } },
    },
  );
  const shareText = await shareResponse.text();
  expect(
    shareResponse.ok(),
    `Link-grant creation for media ${mediaId} failed: ${shareResponse.status()} ${shareText.slice(0, 500)}`,
  ).toBeTruthy();
  const share = (
    JSON.parse(shareText) as {
      data: {
        share: { kind: "Link"; handle: string; publicHref: string };
      };
    }
  ).data.share;
  expect(
    share.publicHref,
    `Link grant ${share.handle} did not target the local web runtime.`,
  ).toMatch(new RegExp(`^${webOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/s#share=`));

  await page.context().clearCookies();
  const anonymousPage = await page.context().newPage();
  await gotoWithStrictCsp(anonymousPage, share.publicHref);
  await expect(
    anonymousPage.getByRole("heading", {
      level: 1,
      name: "There's Water on the Moon?",
    }),
    `Anonymous link grant ${share.handle} did not project media ${mediaId}.`,
  ).toBeVisible();
  await expect(
    anonymousPage.getByText(/SOFIA mission detected water molecules/i),
  ).toBeVisible();
  await expect(
    anonymousPage.getByText(
      "Read-only shared view. No Nexus account is required.",
    ),
  ).toBeVisible();

  const accountResponse = await anonymousPage.request.get("/api/me");
  expect(
    accountResponse.status(),
    `Public grant ${share.handle} unexpectedly minted authenticated account access.`,
  ).toBe(401);
  const privateMediaResponse = await anonymousPage.request.get(
    `/api/media/${mediaId}`,
  );
  expect(
    privateMediaResponse.status(),
    `Public grant ${share.handle} escaped its projection and exposed the authenticated media API.`,
  ).toBe(401);
});
