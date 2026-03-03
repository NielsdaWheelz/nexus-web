import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededYoutubeMedia {
  media_id: string;
  playback_only_media_id: string;
  watch_url: string;
  embed_url: string;
  seek_segment_text: string;
  seek_segment_start_ms: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSeededYoutubeMedia(): SeededYoutubeMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "youtube-media.json");
  const raw = readFileSync(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as SeededYoutubeMedia;

  const requiredStringFields: Array<keyof SeededYoutubeMedia> = [
    "media_id",
    "watch_url",
    "embed_url",
    "seek_segment_text",
  ];
  for (const field of requiredStringFields) {
    const value = parsed[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Invalid seeded YouTube metadata field "${field}" at ${seedPath}`);
    }
  }

  if (
    typeof parsed.seek_segment_start_ms !== "number" ||
    !Number.isFinite(parsed.seek_segment_start_ms)
  ) {
    throw new Error(`Invalid seeded YouTube seek_segment_start_ms at ${seedPath}`);
  }

  return parsed;
}

function parseCspDirectives(cspHeader: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of cspHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [name, ...values] = directive.split(/\s+/);
    directives.set(name, values);
  }
  return directives;
}

test.describe("youtube transcript runtime csp", () => {
  test("enforces exact frame-src allowlist at runtime and blocks disallowed embeds", async ({
    page,
  }) => {
    const seed = readSeededYoutubeMedia();

    await page.addInitScript(() => {
      const win = window as unknown as {
        __cspViolations?: Array<{
          effectiveDirective?: string;
          violatedDirective?: string;
          blockedURI?: string;
        }>;
      };
      win.__cspViolations = [];
      window.addEventListener("securitypolicyviolation", (event) => {
        const list = win.__cspViolations ?? [];
        list.push({
          effectiveDirective: event.effectiveDirective,
          violatedDirective: event.violatedDirective,
          blockedURI: event.blockedURI,
        });
        win.__cspViolations = list;
      });
    });

    const response = await page.goto(`/media/${seed.media_id}`);
    expect(response).not.toBeNull();
    const cspHeader = await response!.headerValue("content-security-policy");
    expect(cspHeader).toBeTruthy();

    const directives = parseCspDirectives(cspHeader ?? "");
    const frameSrc = directives.get("frame-src");
    expect(frameSrc).toEqual([
      "https://www.youtube.com",
      "https://www.youtube-nocookie.com",
    ]);
    expect(frameSrc).not.toContain("*");

    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "https://example.com/";
      frame.setAttribute("title", "disallowed-frame");
      document.body.appendChild(frame);
    });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const win = window as unknown as {
              __cspViolations?: Array<{
                effectiveDirective?: string;
                violatedDirective?: string;
                blockedURI?: string;
              }>;
            };
            const violations = win.__cspViolations ?? [];
            return violations.some((entry) => {
              const directive = entry.effectiveDirective ?? entry.violatedDirective ?? "";
              const blocked = entry.blockedURI ?? "";
              return directive.includes("frame-src") && blocked.includes("example.com");
            });
          }),
        { timeout: 10_000 }
      )
      .toBe(true);
  });

  test("keeps youtube transcript embed + click-to-seek working with csp enabled", async ({
    page,
  }) => {
    const seed = readSeededYoutubeMedia();
    const expectedStartSeconds = Math.floor(seed.seek_segment_start_ms / 1000);

    await page.goto(`/media/${seed.media_id}`);
    await expect(page).toHaveURL(new RegExp(`/media/${seed.media_id}`), {
      timeout: 20_000,
    });
    await expect(page.getByText("Loading media...")).toHaveCount(0, {
      timeout: 20_000,
    });
    const playerFrame = page.locator('iframe[title="YouTube video player"]');
    await expect(playerFrame).toBeVisible({ timeout: 20_000 });
    await expect(playerFrame).toHaveAttribute(
      "src",
      new RegExp(escapeRegExp(seed.embed_url))
    );

    const seekSegmentButton = page.getByRole("button", {
      name: new RegExp(escapeRegExp(seed.seek_segment_text), "i"),
    });
    await expect(seekSegmentButton).toBeVisible();
    await seekSegmentButton.click();

    await expect
      .poll(async () => (await playerFrame.getAttribute("src")) ?? "", {
        timeout: 10_000,
      })
      .toContain(`start=${expectedStartSeconds}`);
  });
});
