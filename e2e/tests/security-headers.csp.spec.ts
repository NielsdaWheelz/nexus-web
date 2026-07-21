import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import { AUTHENTICATED_HOME_PATH } from "./app-routes";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

/**
 * Strict-CSP coverage for the document/static security-header surface
 * (docs/cutovers/csp-and-security-headers-hardening.md). Runs under the
 * chromium-csp profile with CSP enforced (E2E_DISABLE_CSP=0).
 *
 * Two halves:
 * 1. The document response carries the exact strict policy + modern header suite.
 * 2. The major app routes render with ZERO securitypolicyviolation events under
 *    enforcement. The PDF route is the functional gate for the presigned-storage
 *    connect-src (PDF.js fetches the signed MinIO URL) plus the pdf.js worker and
 *    dynamic /pdfjs module imports.
 */

interface SeededMedia {
  media_id: string;
}

function readSeed<T>(seedFile: string): T {
  const seedPath = path.join(__dirname, "..", ".seed", seedFile);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

// Records securitypolicyviolation events. Must be installed before navigation; the
// init script re-runs (and resets the buffer) on every document, so assertions reflect
// only the most recently navigated page.
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

function parseCspDirectives(header: string): Map<string, string[]> {
  return new Map(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...values] = directive.split(/\s+/);
        return [name, values] as const;
      }),
  );
}

test.describe("security headers (enforced CSP)", () => {
  test("document response carries the strict CSP and modern header suite", async ({
    page,
  }) => {
    const response = await page.goto(AUTHENTICATED_HOME_PATH);
    expect(response).not.toBeNull();

    const csp = await response!.headerValue("content-security-policy");
    expect(csp).toBeTruthy();
    const directives = parseCspDirectives(csp!);

    // Strict script-src: nonce + strict-dynamic, no CSP2 fallback, no unsafe-inline.
    const scriptSrc = directives.get("script-src") ?? [];
    expect(scriptSrc.some((source) => source.startsWith("'nonce-"))).toBe(true);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    // Fetch classes are explicit + backstopped.
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);

    // connect-src allowlists the FastAPI/SSE origin and the presigned-storage origin
    // (ports resolved at runtime by the test services).
    const connectSrc = directives.get("connect-src") ?? [];
    expect(connectSrc).toContain("'self'");
    expect(connectSrc.some((origin) => origin.startsWith("http://localhost:"))).toBe(
      true,
    );
    expect(
      connectSrc.some((origin) => origin.startsWith("http://127.0.0.1:")),
    ).toBe(true);

    // Reporting is wired; local HTTP document omits upgrade-insecure-requests.
    expect(directives.get("report-to")).toEqual(["csp"]);
    expect(directives.get("report-uri")).toEqual(["/api/csp-report"]);
    expect(directives.has("upgrade-insecure-requests")).toBe(false);
    expect(await response!.headerValue("reporting-endpoints")).toContain(
      "/api/csp-report",
    );

    // Static suite present; legacy X-Frame-Options removed (frame-ancestors owns it).
    const headers = response!.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["x-frame-options"]).toBeUndefined();
  });
});

test.describe("major routes load with zero CSP violations (enforced)", () => {
  test("libraries", async ({ page }, testInfo) => {
    await recordCspViolations(page);
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-csp-libraries"),
      "/libraries",
    );
    await expect(
      activeWorkspacePane(page).getByPlaceholder("New library name..."),
    ).toBeVisible({ timeout: 15_000 });
    await expectNoCspViolations(page);
  });

  test("search", async ({ page }, testInfo) => {
    await recordCspViolations(page);
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-csp-search"),
      "/search",
    );
    await expect(
      activeWorkspacePane(page).getByLabel("Search content"),
    ).toBeVisible({ timeout: 15_000 });
    await expectNoCspViolations(page);
  });

  test("pdf reader (presigned-storage connect-src + worker + pdfjs imports)", async ({
    page,
  }, testInfo) => {
    await recordCspViolations(page);
    const { media_id } = readSeed<SeededMedia>("pdf-media.json");
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-csp-pdf"),
      `/media/${media_id}`,
    );
    const pane = activeWorkspacePane(page);
    await expect(
      pane.getByRole("toolbar", { name: "PDF controls" }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      pane
        .locator(
          '.pdfViewer .page .textLayer, [class*="pageLayer"] [class*="textLayer"]',
        )
        .last(),
    ).toBeVisible({ timeout: 20_000 });
    await expectNoCspViolations(page);
  });

  test("epub reader", async ({ page }, testInfo) => {
    await recordCspViolations(page);
    const { media_id } = readSeed<SeededMedia>("epub-media.json");
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-csp-epub"),
      `/media/${media_id}`,
    );
    await expect(
      activeWorkspacePane(page).locator('div[class*="fragments"]').first(),
    ).toBeVisible({ timeout: 20_000 });
    await expectNoCspViolations(page);
  });

  test("html article (sanitized HTML + proxied images)", async ({
    page,
  }, testInfo) => {
    await recordCspViolations(page);
    const { media_id } = readSeed<SeededMedia>("non-pdf-media.json");
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-csp-html"),
      `/media/${media_id}`,
    );
    await expect(
      activeWorkspacePane(page).locator('div[class*="fragments"]').first(),
    ).toBeVisible({ timeout: 20_000 });
    await expectNoCspViolations(page);
  });

  test("youtube media (frame-src + Permissions-Policy delegation)", async ({
    page,
  }, testInfo) => {
    await recordCspViolations(page);
    const { media_id } = readSeed<SeededMedia>("youtube-media.json");
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-csp-youtube"),
      `/media/${media_id}`,
    );
    await expect(
      activeWorkspacePane(page).locator('iframe[title="YouTube video player"]'),
    ).toBeVisible({ timeout: 20_000 });
    await expectNoCspViolations(page);
  });

  test("oracle", async ({ page }) => {
    await recordCspViolations(page);
    await page.goto("/oracle");
    await expect(
      page.getByText("Black Forest Oracle", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expectNoCspViolations(page);
  });

  test("chat composer", async ({ page }) => {
    await recordCspViolations(page);
    await page.goto("/libraries");
    const created = await page.request.post("/api/conversations", {
      maxRedirects: 0,
      headers: stateChangingApiHeaders(),
    });
    expect(created.ok()).toBeTruthy();
    const conversationId = (
      JSON.parse(await created.text()) as { data: { id: string } }
    ).data.id;
    try {
      await page.goto(`/conversations/${conversationId}`);
      await expect(
        page.getByRole("textbox", { name: /ask anything/i }),
      ).toBeVisible({ timeout: 30_000 });
      await expectNoCspViolations(page);
    } finally {
      await page.request.delete(`/api/conversations/${conversationId}`, {
        headers: stateChangingApiHeaders(),
      });
    }
  });
});
