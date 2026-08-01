import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const SCRIPT_ONLY_SECRET_KEYS = [
  "SERVICE_ROLE_KEY",
  "SUPABASE_AUTH_ADMIN_KEY",
  "SUPABASE_DATABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

interface CanonicalFindFixture {
  web_media_id: string;
  transcript_media_id: string;
  artifact_ref: string;
  revision_ref: string;
  web_query: string;
  transcript_query: string;
  transcript_zero_query: string;
  artifact_query: string;
}

function childAppRuntimeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SCRIPT_ONLY_SECRET_KEYS) delete env[key];
  return env;
}

function runFixture(
  mode: "seed" | "cleanup",
  ownerId: string,
  fixture?: CanonicalFindFixture,
): CanonicalFindFixture | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the Canonical Find fixture");
  }
  const output = execFileSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "e2e/seed-canonical-find-journey.py",
    ],
    {
      cwd: ROOT_DIR,
      env: {
        ...childAppRuntimeEnv(),
        DATABASE_URL: databaseUrl.replace(
          /^postgresql:\/\//,
          "postgresql+psycopg://",
        ),
        NEXUS_E2E_CANONICAL_FIND_MODE: mode,
        NEXUS_E2E_OWNER_USER_ID: ownerId,
        ...(fixture
          ? {
              NEXUS_E2E_CANONICAL_FIND_FIXTURE:
                JSON.stringify(fixture),
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).toString("utf-8");
  if (mode === "cleanup") return null;
  const jsonLine = output.trim().split("\n").at(-1);
  if (!jsonLine) throw new Error("Canonical Find seed produced no JSON");
  return JSON.parse(jsonLine) as CanonicalFindFixture;
}

async function expectOk(
  response: {
    ok(): boolean;
    status(): number;
    text(): Promise<string>;
  },
  label: string,
): Promise<void> {
  expect(
    response.ok(),
    `${label}: ${response.status()} ${(await response.text()).slice(0, 400)}`,
  ).toBeTruthy();
}

async function ownerId(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/me");
  await expectOk(response, "Read E2E viewer");
  return ((await response.json()) as { data: { user_id: string } }).data
    .user_id;
}

async function readerState(
  request: APIRequestContext,
  mediaId: string,
): Promise<unknown> {
  const response = await request.get(`/api/media/${mediaId}/reader-state`);
  await expectOk(response, `Read reader state for ${mediaId}`);
  return ((await response.json()) as { data: unknown }).data;
}

function trackReaderStateWrites(
  page: Page,
  mediaIds: readonly string[],
): { readonly writes: Request[]; readonly dispose: () => void } {
  const paths = new Set(
    mediaIds.map((mediaId) => `/api/media/${mediaId}/reader-state`),
  );
  const writes: Request[] = [];
  const capture = (request: Request) => {
    if (
      request.method() === "PUT" &&
      paths.has(new URL(request.url()).pathname)
    ) {
      writes.push(request);
    }
  };
  page.on("request", capture);
  return {
    writes,
    dispose: () => page.off("request", capture),
  };
}

function visibleSearchResults(page: Page): Locator {
  return page
    .getByRole("list", { name: "Search results" })
    .filter({ visible: true });
}

async function expectFindStatus(
  pane: Locator,
  text: string,
): Promise<void> {
  await expect(
    pane.getByRole("status").filter({ hasText: text }),
  ).toHaveText(text);
}

async function expectFindReady(pane: Locator): Promise<void> {
  await expect(
    pane.getByRole("button", { name: "Find", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

async function openFindResults(
  page: Page,
  pane: Locator,
): Promise<void> {
  const button = pane.getByRole("button", { name: "Results" });
  await button.click();
  await expect(
    page
      .locator('button[aria-expanded="true"]')
      .filter({ hasText: /^Results$/ }),
  ).toHaveCount(1);
}

async function returnToReadingPosition(pane: Locator): Promise<void> {
  await pane
    .getByTestId("pane-contextual-row")
    .getByRole("button", { name: "Go back to reading position" })
    .click();
}

async function closeFind(pane: Locator): Promise<void> {
  await pane
    .getByTestId("pane-contextual-row")
    .getByRole("button", { name: "Close search", exact: true })
    .click();
}

test("Canonical Find preserves reading state across Web, partial transcript, and Artifact results", async ({
  page,
}, testInfo) => {
  test.slow();
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    browserErrors.push(error.stack ?? error.message);
  });
  const viewerId = await ownerId(page.request);
  let fixture: CanonicalFindFixture | null = null;
  let productError: unknown = null;

  try {
    fixture = runFixture("seed", viewerId);
    if (!fixture) {
      throw new Error("Canonical Find fixture was not created");
    }
    const writeTracker = trackReaderStateWrites(page, [
      fixture.web_media_id,
      fixture.transcript_media_id,
    ]);

    try {
      // Web: parent Ctrl+F, all-fragment results, stepping, Companion, Return,
      // and no URL/progress mutation.
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-canonical-find-web"),
        `/media/${fixture.web_media_id}`,
      );
      let pane = activeWorkspacePane(page);
      const webViewport = pane.getByRole("region", {
        name: "Document reading area",
      });
      await expect(webViewport).toBeVisible({ timeout: 15_000 });
      const webUrl = page.url();
      const webStateBefore = await readerState(
        page.request,
        fixture.web_media_id,
      );

      await expectFindReady(pane);
      await page.keyboard.press("Control+f");
      const webInput = pane.getByRole("searchbox", {
        name: "Find in article",
      });
      await expect(webInput).toBeFocused();
      await webInput.fill(fixture.web_query);
      await expectFindStatus(pane, "1 of 3 matches");
      await pane.getByRole("button", { name: "Next match" }).click();
      await expectFindStatus(pane, "2 of 3 matches");
      await openFindResults(page, pane);
      let results = visibleSearchResults(page);
      await expect(results).toBeVisible();
      await expect(results.getByRole("listitem")).toHaveCount(3);
      await results
        .getByRole("button", { name: /Go to match: 3 of 3:/ })
        .click();
      await expectFindStatus(pane, "3 of 3 matches");
      await returnToReadingPosition(pane);
      await expect(webViewport).toBeFocused();
      expect(page.url()).toBe(webUrl);
      expect(
        await readerState(page.request, fixture.web_media_id),
      ).toEqual(webStateBefore);
      await closeFind(pane);
      await expect(visibleSearchResults(page)).toHaveCount(0);

      // Transcript: explicit partial-zero and partial-result copy, exact
      // occurrence stepping, Companion rows, Return, and no seek/progress/URL.
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-canonical-find-transcript"),
        `/media/${fixture.transcript_media_id}`,
      );
      pane = activeWorkspacePane(page);
      await expect(
        pane.getByText(
          "Transcript is partial; search and highlights cover only the available transcript.",
        ),
      ).toBeVisible({ timeout: 15_000 });
      const transcriptSegments = pane.getByRole("region", {
        name: "Transcript segments",
      });
      const playerFrame = pane.locator("iframe").first();
      await expect(playerFrame).toBeVisible();
      const playbackSource = await playerFrame.getAttribute("src");
      const transcriptUrl = page.url();
      const transcriptStateBefore = await readerState(
        page.request,
        fixture.transcript_media_id,
      );

      await expectFindReady(pane);
      await page.keyboard.press("Control+f");
      const transcriptInput = pane.getByRole("searchbox", {
        name: "Find in transcript",
      });
      await expect(transcriptInput).toBeFocused();
      await transcriptInput.fill(fixture.transcript_zero_query);
      await expectFindStatus(
        pane,
        "No matches in the available transcript; results are incomplete",
      );
      await transcriptInput.fill(fixture.transcript_query);
      await expectFindStatus(
        pane,
        "1 of 3 matches in the available transcript; results are incomplete",
      );
      await openFindResults(page, pane);
      results = visibleSearchResults(page);
      await expect(
        page.getByText(
          "Showing matches in the available transcript. Results are incomplete.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(results.getByRole("listitem")).toHaveCount(3);
      await pane.getByRole("button", { name: "Next match" }).click();
      await expectFindStatus(
        pane,
        "2 of 3 matches in the available transcript; results are incomplete",
      );
      await expect(
        transcriptSegments.getByRole("button", {
          name: new RegExp(
            `Current match: ${fixture.transcript_query}`,
            "i",
          ),
        }),
      ).toBeVisible();
      await results
        .getByRole("button", { name: /Go to match: 3 of 3:/ })
        .click();
      await expectFindStatus(
        pane,
        "3 of 3 matches in the available transcript; results are incomplete",
      );
      expect(await playerFrame.getAttribute("src")).toBe(playbackSource);
      expect(page.url()).toBe(transcriptUrl);
      expect(
        await readerState(page.request, fixture.transcript_media_id),
      ).toEqual(transcriptStateBefore);
      await returnToReadingPosition(pane);
      await expect(transcriptSegments).toBeFocused();
      expect(await playerFrame.getAttribute("src")).toBe(playbackSource);
      expect(page.url()).toBe(transcriptUrl);
      await closeFind(pane);

      // Accepted standalone Artifact: the shortcut originates inside the
      // opaque iframe, results open in transient Companion, and Return restores
      // focus to the frame without changing the canonical revision URL.
      const artifactHref =
        `/artifacts/${encodeURIComponent(fixture.artifact_ref)}`;
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-canonical-find-artifact"),
        artifactHref,
      );
      pane = activeWorkspacePane(page);
      const dossierFrame = pane.getByTitle(
        "Learning dossier: E2E Canonical Find web article",
      );
      await expect(dossierFrame).toBeVisible({ timeout: 15_000 });
      const artifactUrl = page.url();
      const dossier = pane.frameLocator(
        'iframe[title="Learning dossier: E2E Canonical Find web article"]',
      );
      const artifactOrientation = dossier.getByRole("heading", {
        name: "Artifact orientation",
      });
      await expect(artifactOrientation).toBeVisible({ timeout: 15_000 });
      await artifactOrientation.click();
      await expectFindReady(pane);
      await page.keyboard.press("Control+f");
      const artifactInput = pane.getByRole("searchbox", {
        name: "Find in dossier",
      });
      await expect(artifactInput).toBeFocused();
      await artifactInput.fill(fixture.artifact_query);
      await expectFindStatus(pane, "1 of 2 matches");
      await openFindResults(page, pane);
      results = visibleSearchResults(page);
      await expect(results.getByRole("listitem")).toHaveCount(2);
      await expect(
        results.getByRole("button", {
          name: /Current match: 1 of 2: Artifact target section:/,
        }),
      ).toBeVisible();
      await results
        .getByRole("button", { name: /Go to match: 2 of 2:/ })
        .click();
      await expectFindStatus(pane, "2 of 2 matches");
      expect(page.url()).toBe(artifactUrl);
      await returnToReadingPosition(pane);
      await expect(dossierFrame).toBeFocused();
      expect(page.url()).toBe(artifactUrl);
      await closeFind(pane);
      await expect(visibleSearchResults(page)).toHaveCount(0);

      expect(
        writeTracker.writes.map((request) => request.url()),
      ).toEqual([]);
    } finally {
      writeTracker.dispose();
    }
  } catch (error) {
    productError = error;
    await testInfo.attach("canonical-find-browser-errors", {
      body: browserErrors.join("\n\n"),
      contentType: "text/plain",
    });
    await testInfo.attach("canonical-find-failure-dom", {
      body: await page.content(),
      contentType: "text/html",
    });
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await page.goto("about:blank");
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (fixture) {
      try {
        runFixture("cleanup", viewerId, fixture);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [productError, ...cleanupErrors].filter(
          (error): error is NonNullable<typeof error> =>
            error !== null && error !== undefined,
        ),
        "Canonical Find journey cleanup failed",
      );
    }
  }
});
