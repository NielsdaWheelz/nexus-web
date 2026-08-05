import { captureCanonicalArticle } from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { pageRequest } from "../request";

test.use({ journeyId: "resource-share-boundary" });

test("a link grant exposes only its read-only resource and does not mint an account session", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const mediaId = await captureCanonicalArticle(page, "shared-source");
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${mediaId}`);
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

  const shareResponse = await api.post(
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

  const ownerMediaResponse = await api.get(`/api/media/${mediaId}`);
  const ownerMediaText = await ownerMediaResponse.text();
  expect(
    ownerMediaResponse.ok(),
    `Owner could not read media ${mediaId} before checking its public projection: ${ownerMediaResponse.status()} ${ownerMediaText.slice(0, 500)}`,
  ).toBeTruthy();
  const ownerMedia = JSON.parse(ownerMediaText) as {
    data: { title: string };
  };
  expect(
    ownerMedia.data.title.length,
    `Media ${mediaId} had no owner-visible title to preserve in its public projection.`,
  ).toBeGreaterThan(0);

  await page.context().clearCookies();
  const anonymousPage = await page.context().newPage();
  await gotoWithStrictCsp(anonymousPage, share.publicHref);
  await expect(
    anonymousPage.getByRole("heading", {
      level: 1,
      name: ownerMedia.data.title,
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
  // The reader owns this tab in every state, so the recipient's browser names
  // the shared document rather than the app. Read the settled title instead of
  // polling for it: a polled title that never arrives times out, and a timeout
  // is an execution failure that can never demonstrate this defect.
  expect(
    await anonymousPage.title(),
    `Link grant ${share.handle} did not name the recipient's tab after media ${mediaId}.`,
  ).toBe(`${ownerMedia.data.title} · Nexus`);

  const anonymousApi = pageRequest(anonymousPage, webOrigin);
  const servedShareTitles = [
    ...(await (await anonymousApi.get("/s")).text()).matchAll(
      /<title[^>]*>([^<]*)<\/title>/g,
    ),
  ].map((match) => match[1]);
  expect(
    servedShareTitles.at(-1),
    `The document served for a share link must end at the reader's own title element; a metadata title would outlive it and rename the open share after hydration. Received ${JSON.stringify(servedShareTitles)}.`,
  ).toBe("Shared reading · Nexus");
  const accountResponse = await anonymousApi.get("/api/me");
  expect(
    accountResponse.status(),
    `Public grant ${share.handle} unexpectedly minted authenticated account access.`,
  ).toBe(401);
  const privateMediaResponse = await anonymousApi.get(
    `/api/media/${mediaId}`,
  );
  expect(
    privateMediaResponse.status(),
    `Public grant ${share.handle} escaped its projection and exposed the authenticated media API.`,
  ).toBe(401);

  // A token outside the grant reveals nothing, and the tab names that state
  // instead of the app: the reader owns the title whether or not it resolves.
  const strangerPage = await page.context().newPage();
  await gotoWithStrictCsp(strangerPage, `${webOrigin}/s#share=${"0".repeat(43)}`);
  await expect(
    strangerPage.getByRole("heading", { level: 1, name: "Share unavailable" }),
    `An unknown share token must resolve to nothing readable, not to media ${mediaId}.`,
  ).toBeVisible();
  expect(
    await strangerPage.title(),
    "An unresolved share must name its own state in the recipient's tab.",
  ).toBe("Share unavailable · Nexus");
});
