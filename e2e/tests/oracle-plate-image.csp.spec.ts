import { test, expect, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Strict-CSP regression for the oracle-plate owned-asset cutover
 * (docs/cutovers/oracle-plate-owned-asset-cutover.md §16 "E2E CSP"). Runs under
 * the chromium-csp profile with CSP enforced (E2E_DISABLE_CSP=0), production build.
 *
 * The reading page renders its plate through next/image (kind="owned", NOT
 * unoptimized), so the browser hits the local optimizer at
 *   /_next/image?url=%2Fapi%2Foracle%2Fplates%2F{image_id}&w=...&q=...
 * which proxies the public /api/oracle/plates/{id} route. This proves the post-cutover
 * contract:
 *   - the optimizer returns 200 with an image/* content-type (NOT 400, NOT JSON);
 *   - no Wikimedia host is contacted at render time (the app owns the bytes);
 *   - the route renders with ZERO securitypolicyviolation events under enforcement.
 *
 * The reading + its bundled-fixture plate are seeded by global-setup
 * (python/scripts/seed_oracle_plate_e2e.py → e2e/.seed/oracle-plate.json).
 */

interface OraclePlateSeed {
  reading_id: string;
  image_id: string;
  storage_key: string;
  plate_route: string;
}

function readSeed<T>(seedFile: string): T {
  const seedPath = path.join(__dirname, "..", ".seed", seedFile);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

const WIKIMEDIA_HOSTS = ["upload.wikimedia.org", "commons.wikimedia.org"];

function isWikimediaRequest(request: Request): boolean {
  let host: string;
  try {
    host = new URL(request.url()).hostname;
  } catch {
    return false;
  }
  return WIKIMEDIA_HOSTS.includes(host);
}

// The optimizer request for the owned plate: /_next/image with a url= param that
// decodes to the public /api/oracle/plates/{image_id} route.
function isOptimizedPlateRequest(rawUrl: string, imageId: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.pathname !== "/_next/image") {
    return false;
  }
  const inner = parsed.searchParams.get("url");
  return inner !== null && inner === `/api/oracle/plates/${imageId}`;
}

// Records securitypolicyviolation events. Must be installed before navigation; the
// init script re-runs (and resets the buffer) on every document, so assertions reflect
// only the most recently navigated page. Mirrors security-headers.csp.spec.ts.
async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as { __cspViolations?: string[] };
    win.__cspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      const list = (win.__cspViolations ??= []);
      list.push(
        `${event.effectiveDirective || event.violatedDirective} blocked ${event.blockedURI}`,
      );
    });
  });
}

async function expectNoCspViolations(page: Page): Promise<void> {
  const violations = await page.evaluate(
    () =>
      (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
  expect(
    violations,
    `unexpected CSP violations:\n${violations.join("\n")}`,
  ).toEqual([]);
}

test.describe("oracle owned plate (enforced CSP)", () => {
  test("plate renders via the local image optimizer from the owned /api/oracle/plates route, never Wikimedia", async ({
    page,
  }) => {
    const seed = readSeed<OraclePlateSeed>("oracle-plate.json");
    await recordCspViolations(page);

    // Capture every request the page issues so we can assert no Wikimedia host is
    // contacted at render time (the app now owns the plate bytes).
    const wikimediaRequests: string[] = [];
    page.on("request", (request) => {
      if (isWikimediaRequest(request)) {
        wikimediaRequests.push(request.url());
      }
    });

    // Arm the optimizer-response wait before navigating so we never miss the request.
    const optimizedPlateResponse = page.waitForResponse(
      (response) => isOptimizedPlateRequest(response.url(), seed.image_id),
      { timeout: 20_000 },
    );

    await page.goto(`/oracle/${seed.reading_id}`);

    // The plate figure renders from the server-hydrated reading detail.
    await expect(page.locator("figure img").first()).toBeVisible({
      timeout: 20_000,
    });

    const response = await optimizedPlateResponse;
    expect(
      response.status(),
      "optimized oracle plate must return 200, not 400/JSON error",
    ).toBe(200);
    const contentType = (await response.headerValue("content-type")) ?? "";
    expect(
      contentType.toLowerCase().startsWith("image/"),
      `optimized oracle plate content-type must be image/*, got: ${contentType}`,
    ).toBe(true);

    // No Wikimedia host may be contacted at request time.
    expect(
      wikimediaRequests,
      `unexpected Wikimedia requests:\n${wikimediaRequests.join("\n")}`,
    ).toEqual([]);

    await expectNoCspViolations(page);
  });
});
