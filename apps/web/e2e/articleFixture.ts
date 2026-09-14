import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { isolatedRequest, pageRequest, requireExactOrigin } from "./request";
import { webOrigin } from "./fixtures";

export const ARTICLE_SOURCE_URL =
  "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/";
export const ARTICLE_TITLE = "There's Water on the Moon?";
export const ARTICLE_QUOTE =
  "The SOFIA mission detected water molecules in Clavius Crater";

const TEST_EXTENSION_REDIRECT_ORIGIN =
  "https://pfcfdmanlahjkanalhpnfjflgaaahgib.chromiumapp.org";
const ARTICLE_READINESS_TIMEOUT_MS = 90_000;

async function captureCanonicalArticle(
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
    const data = (
      JSON.parse(text) as {
        data?: { ingest_enqueued?: unknown; media_id?: unknown };
      }
    ).data;
    if (!data || typeof data.media_id !== "string") {
      throw new Error("Article fixture capture omitted its media identity.");
    }
    if (data.ingest_enqueued !== true) {
      throw new Error(
        `Article fixture capture did not enqueue durable ingest: body=${text.slice(0, 500)}`,
      );
    }
    return data.media_id;
  } finally {
    await extension.dispose();
  }
}

/**
 * Capture the canonical article and wait for its complete reader/search
 * projection. Bounded-child ingest plus the fresh-database maintenance queue
 * can legitimately exceed the old in-process worker's 25-second bound.
 */
export async function captureReadableArticle(
  page: Page,
  scenario: string,
): Promise<string> {
  const mediaId = await captureCanonicalArticle(page, scenario);
  const app = pageRequest(page, webOrigin);
  await expect
    .poll(
      async () => {
        const response = await app.get(`/api/media/${mediaId}`);
        if (!response.ok()) return `http-${response.status()}`;
        const media = (await response.json()) as {
          data: {
            processing_status: string;
            retrieval_status: string | null;
            last_error_code: string | null;
          };
        };
        // The error code rides the polled string so a readiness failure names
        // its ingest-stage cause in the assertion output instead of dying as
        // an anonymous "failed".
        return `${media.data.processing_status}:${media.data.retrieval_status}:${
          media.data.last_error_code ?? ""
        }`;
      },
      {
        message: `Expected captured article ${mediaId} to become readable and searchable.`,
        timeout: ARTICLE_READINESS_TIMEOUT_MS,
      },
    )
    .toBe("ready_for_reading:ready:");
  return mediaId;
}
