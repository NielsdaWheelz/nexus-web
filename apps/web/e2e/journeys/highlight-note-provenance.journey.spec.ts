import { randomUUID } from "node:crypto";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";

test.use({ journeyId: "highlight-note-provenance" });

const SOURCE_URL =
  "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/";
const QUOTE = "The SOFIA mission detected water molecules in Clavius Crater";

async function ingestArticle(page: Parameters<typeof signIn>[0]): Promise<string> {
  const response = await page.request.post("/api/media/from-url", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": `highlight-source-${randomUUID()}`,
    },
    data: { url: SOURCE_URL, library_ids: [] },
  });
  const text = await response.text();
  expect(
    response.ok(),
    `Article acceptance failed at the BFF boundary: ${response.status()} ${text.slice(0, 500)}`,
  ).toBeTruthy();
  const mediaId = (JSON.parse(text) as { data: { media_id: string } }).data
    .media_id;
  await expect
    .poll(
      async () => {
        const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
        if (!mediaResponse.ok()) return `http-${mediaResponse.status()}`;
        const media = (await mediaResponse.json()) as {
          data: { retrieval_status: string | null };
        };
        return media.data.retrieval_status;
      },
      {
        message: `Expected article ${mediaId} to publish its document map before annotation.`,
        timeout: 25_000,
      },
    )
    .toBe("ready");
  return mediaId;
}

test("a highlight note remains attached to the exact canonical passage after a fresh document", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const mediaId = await ingestArticle(page);
  const fragmentsResponse = await page.request.get(
    `/api/media/${mediaId}/fragments`,
  );
  const fragmentsText = await fragmentsResponse.text();
  expect(
    fragmentsResponse.ok(),
    `Fragment read for media ${mediaId} failed: ${fragmentsResponse.status()} ${fragmentsText.slice(0, 500)}`,
  ).toBeTruthy();
  const fragments = (
    JSON.parse(fragmentsText) as {
      data: Array<{ id: string; canonical_text: string }>;
    }
  ).data;
  const fragment = fragments.find(({ canonical_text: text }) =>
    text.includes(QUOTE),
  );
  expect(
    fragment,
    `Canonical fragments for media ${mediaId} omitted the independently known SOFIA passage.`,
  ).toBeDefined();
  const startOffset = fragment!.canonical_text.indexOf(QUOTE);

  const highlightResponse = await page.request.post(
    `/api/fragments/${fragment!.id}/highlights`,
    {
      headers: { origin: webOrigin },
      data: {
        start_offset: startOffset,
        end_offset: startOffset + QUOTE.length,
        color: "green",
      },
    },
  );
  const highlightText = await highlightResponse.text();
  expect(
    highlightResponse.ok(),
    `Highlight creation for fragment ${fragment!.id} failed: ${highlightResponse.status()} ${highlightText.slice(0, 500)}`,
  ).toBeTruthy();
  const highlight = (JSON.parse(highlightText) as {
    data: { id: string; exact: string };
  }).data;
  expect(
    highlight.exact,
    `Highlight ${highlight.id} drifted from canonical offsets ${startOffset}:${startOffset + QUOTE.length}.`,
  ).toBe(QUOTE);

  const noteText = "Keep this finding tied to its exact source passage.";
  const noteResponse = await page.request.put(
    `/api/highlights/${highlight.id}/note`,
    {
      headers: { origin: webOrigin },
      data: {
        note_block_id: randomUUID(),
        client_mutation_id: `highlight-note-${randomUUID()}`,
        body_pm_json: {
          type: "paragraph",
          content: [{ type: "text", text: noteText }],
        },
      },
    },
  );
  expect(
    noteResponse.ok(),
    `Note creation for highlight ${highlight.id} failed: ${noteResponse.status()} ${await noteResponse.text()}`,
  ).toBeTruthy();

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(
    page.getByRole("heading", { name: "There's Water on the Moon?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  const evidenceTab = page.getByRole("tab", { name: "Evidence" });
  await evidenceTab.click();
  await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
  const evidence = page.getByRole("article").filter({ hasText: QUOTE });
  await expect(
    evidence,
    `Evidence for highlight ${highlight.id} did not retain canonical quote ${JSON.stringify(QUOTE)}.`,
  ).toBeVisible();
  await expect(
    evidence.getByText(noteText, { exact: true }),
    `Evidence for highlight ${highlight.id} did not retain its linked note.`,
  ).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^Jump to .*${QUOTE}`) }).click();
  const activatedPassage = page.locator(
    `[data-active-highlight-ids~="${highlight.id}"]`,
  );
  await expect(
    activatedPassage,
    `Document Map activation did not render and reveal highlight ${highlight.id} in its owned reader fragment.`,
  ).toBeVisible();
  await expect(activatedPassage).toContainText(QUOTE);

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await page.getByRole("tab", { name: "Evidence" }).click();
  await expect(
    page.getByRole("article").filter({ hasText: QUOTE }).getByText(noteText),
    `Fresh document load lost note provenance for highlight ${highlight.id}.`,
  ).toBeVisible();
});
