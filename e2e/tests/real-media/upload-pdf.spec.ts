import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  expectVisiblePdfEvidenceHighlight,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media real PDF opens from upload-backed media and projects evidence", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.pdf.media_id;
  const query = seed.fixtures.pdf.query;
  const artifactPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "python",
    "tests",
    "fixtures",
    "pdf",
    "attention.pdf",
  );

  await page.goto("/libraries");
  await page.getByRole("button", { name: "Add content" }).click();
  const addContentDialog = page.getByRole("dialog", { name: "Add content" });
  await expect(addContentDialog).toBeVisible();
  await addContentDialog.getByLabel("Upload file").setInputFiles(artifactPath);
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}(\\?|$)`), {
    timeout: 30_000,
  });

  const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
  expect(
    mediaResponse.ok(),
    `PDF media ${mediaId} should be readable`,
  ).toBeTruthy();
  const media = await mediaResponse.json();
  expect(media.data.kind).toBe("pdf");
  expect(media.data.retrieval_status).toBe("ready");

  const fileResponse = await page.request.get(`/api/media/${mediaId}/file`);
  expect(
    fileResponse.ok(),
    `PDF media ${mediaId} should expose its real file`,
  ).toBeTruthy();
  expect((await fileResponse.json()).data.url).toBeTruthy();

  const search = await searchRealMediaEvidenceThroughUi(page, query, "pdf");
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(result, "real PDF should return indexed evidence").toBeTruthy();
  if (!result) {
    throw new Error(`real PDF visible search did not return ${mediaId}`);
  }
  const resolverResponse = await page.request.get(
    `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
  );
  expect(resolverResponse.ok()).toBeTruthy();
  const resolver = await resolverResponse.json();

  const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
  await expect(resultLink, "real PDF should render a visible search result").toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");
  await resultLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
  await expect(page.locator("body")).not.toContainText(
    /not found|failed to load/i,
  );
  expect(["resolved", "no_geometry"]).toContain(resolver.data.resolver.status);
  if (resolver.data.resolver.status === "resolved") {
    await expectVisiblePdfEvidenceHighlight(page);
  } else {
    await expect(page.getByRole("toolbar", { name: "PDF controls" })).toBeVisible();
  }
  const resolvedPageNumber = Number.parseInt(
    String(resolver.data.resolver.params.page ?? "1"),
    10,
  );
  const pageNumber =
    Number.isInteger(resolvedPageNumber) && resolvedPageNumber >= 1
      ? resolvedPageNumber
      : 1;
  const exact = `real-media-pdf-highlight-${Date.now()}`;
  const existingHighlightResponse = await page.request.get(
    `/api/media/${mediaId}/pdf-highlights?page_number=${pageNumber}&mine_only=false`,
  );
  const existingHighlightBody = await existingHighlightResponse.text();
  expect(
    existingHighlightResponse.ok(),
    `PDF highlight list failed with ${existingHighlightResponse.status()} ${existingHighlightResponse.statusText()}: ${existingHighlightBody}`,
  ).toBeTruthy();
  const existingHighlights = JSON.parse(existingHighlightBody) as {
    data: {
      highlights: Array<{
        anchor: {
          quads: Array<{
            x1: number;
            y1: number;
            x2: number;
            y2: number;
            x3: number;
            y3: number;
            x4: number;
            y4: number;
          }>;
        };
      }>;
    };
  };
  const usedQuads = new Set(
    existingHighlights.data.highlights.flatMap((highlight) =>
      highlight.anchor.quads.map(
        (quad) =>
          `${quad.x1}:${quad.y1}:${quad.x2}:${quad.y2}:${quad.x3}:${quad.y3}:${quad.x4}:${quad.y4}`,
      ),
    ),
  );
  let highlightQuad:
    | {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        x3: number;
        y3: number;
        x4: number;
        y4: number;
      }
    | null = null;
  for (let row = 0; row < 80; row += 1) {
    const top = 120 + row * 7;
    const candidate = {
      x1: 72,
      y1: top,
      x2: 210,
      y2: top,
      x3: 210,
      y3: top + 20,
      x4: 72,
      y4: top + 20,
    };
    if (
      !usedQuads.has(
        `${candidate.x1}:${candidate.y1}:${candidate.x2}:${candidate.y2}:${candidate.x3}:${candidate.y3}:${candidate.x4}:${candidate.y4}`,
      )
    ) {
      highlightQuad = candidate;
      break;
    }
  }
  expect(
    highlightQuad,
    `Expected an unused highlight quad on PDF page ${pageNumber}. Existing highlight count: ${existingHighlights.data.highlights.length}`,
  ).toBeTruthy();
  if (!highlightQuad) {
    throw new Error(`No unused highlight quad found on PDF page ${pageNumber}`);
  }
  let createdHighlightId: string | null = null;

  try {
    const createHighlightResponse = await page.request.post(
      `/api/media/${mediaId}/pdf-highlights`,
      {
        data: {
          page_number: pageNumber,
          exact,
          color: "yellow",
          quads: [highlightQuad],
        },
      },
    );
    const createHighlightBody = await createHighlightResponse.text();
    expect(
      createHighlightResponse.ok(),
      `PDF highlight create failed with ${createHighlightResponse.status()} ${createHighlightResponse.statusText()}: ${createHighlightBody}`,
    ).toBeTruthy();
    const createdHighlight = JSON.parse(createHighlightBody);
    createdHighlightId = createdHighlight.data.id;
    await page.reload();
    await expect(
      page.locator(`[data-testid^="pdf-highlight-${createdHighlight.data.id}-"]`).first(),
    ).toBeVisible({ timeout: 15_000 });
    const savedHighlight = {
      id: createdHighlight.data.id,
      page_number: createdHighlight.data.anchor.page_number,
      exact: createdHighlight.data.exact,
      selected_text: exact,
      container_selector: '[data-testid="pdf-viewport"]',
      action_selector: "POST /api/media/:mediaId/pdf-highlights",
      request_url: createHighlightResponse.url(),
    };

    writeRealMediaTrace(testInfo, "real-pdf-upload-trace.json", {
      fixture_id: "pdf-attention",
      artifact_sha256: seed.fixtures.pdf.artifact_sha256,
      artifact_bytes: seed.fixtures.pdf.artifact_bytes,
      media_id: mediaId,
      query,
      search_api_url: search.api_url,
      search_result: result,
      visible_result_href: visibleHref,
      resolver: resolver.data,
      saved_highlight: savedHighlight,
      browser_url: page.url(),
    });
  } finally {
    if (createdHighlightId) {
      try {
        await page.request.delete(`/api/highlights/${createdHighlightId}`, {
          timeout: 5_000,
        });
      } catch {
        // justify-ignore-error: cleanup must not mask the product assertion.
      }
    }
  }
});
