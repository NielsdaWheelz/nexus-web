import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright/test";
import { isolatedRequest, pageRequest, requireExactOrigin } from "./request";
import { webOrigin } from "./fixtures";

export const ARTICLE_SOURCE_URL =
  "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/";
export const ARTICLE_TITLE = "There's Water on the Moon?";
export const ARTICLE_QUOTE =
  "The SOFIA mission detected water molecules in Clavius Crater";

const TEST_EXTENSION_REDIRECT_ORIGIN =
  "https://pfcfdmanlahjkanalhpnfjflgaaahgib.chromiumapp.org";

export async function captureCanonicalArticle(
  page: Page,
  scenario: string,
): Promise<string> {
  const app = pageRequest(page, webOrigin);
  const redirectUri = `${TEST_EXTENSION_REDIRECT_ORIGIN}/`;
  const handoff = await app.get(
    `/extension/connect/start?redirect_uri=${encodeURIComponent(redirectUri)}`,
  );
  const location = handoff.headers().location;
  if (handoff.status() !== 307 || !location) {
    throw new Error(
      `Article fixture extension handoff failed: status=${handoff.status()} body=${(await handoff.text()).slice(0, 500)}`,
    );
  }
  const redirect = requireExactOrigin(location, TEST_EXTENSION_REDIRECT_ORIGIN);
  const token = new URLSearchParams(redirect.hash.slice(1)).get("token");
  if (!token) throw new Error("Article fixture handoff omitted its scoped token.");

  const sourceHtml = readFileSync(
    path.resolve(
      __dirname,
      "../../../python/tests/fixtures/real_media/nasa-water-on-moon-capture.html",
    ),
    "utf8",
  );
  const extension = await isolatedRequest(webOrigin, {
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const response = await extension.post("/api/media/capture/article", {
      headers: { "Idempotency-Key": `${scenario}-${randomUUID()}` },
      data: {
        url: ARTICLE_SOURCE_URL,
        title: ARTICLE_TITLE,
        content_html: sourceHtml,
        source_html: sourceHtml,
        library_ids: [],
      },
    });
    const text = await response.text();
    if (!response.ok()) {
      throw new Error(
        `Article fixture capture failed: status=${response.status()} body=${text.slice(0, 500)}`,
      );
    }
    const mediaId = (JSON.parse(text) as { data?: { media_id?: unknown } }).data
      ?.media_id;
    if (typeof mediaId !== "string") {
      throw new Error("Article fixture capture omitted its media identity.");
    }
    return mediaId;
  } finally {
    await extension.dispose();
  }
}
