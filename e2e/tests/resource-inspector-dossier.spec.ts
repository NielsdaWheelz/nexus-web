import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { stateChangingApiHeaders } from "./api";
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

interface MediaSeed {
  media_id: string;
}

interface InspectorFixture {
  page_id: string;
  note_id: string;
  podcast_id: string;
  contributor_id: string;
  contributor_handle: string;
  credit_id: string;
  artifact_id: string;
  old_revision_ref: string;
  current_revision_ref: string;
  abstract_text: string;
  summary_id: string;
  summary_backup: Record<string, unknown>;
}

interface ResourceUnderTest {
  name: string;
  href: string;
  linkedItemsTab: "Context" | "Connections" | "Evidence";
  extraTabs?: readonly string[];
}

function readMediaSeed(): MediaSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as MediaSeed;
  if (!seed.media_id) throw new Error(`Invalid media seed at ${seedPath}`);
  return seed;
}

function childAppRuntimeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SCRIPT_ONLY_SECRET_KEYS) delete env[key];
  return env;
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

async function ownerId(page: Page): Promise<string> {
  const response = await page.request.get("/api/me");
  await expectOk(response, "Read E2E viewer");
  return ((await response.json()) as { data: { user_id: string } }).data
    .user_id;
}

async function defaultLibraryId(page: Page): Promise<string> {
  const response = await page.request.get("/api/libraries");
  await expectOk(response, "Read E2E libraries");
  const payload = (await response.json()) as {
    data: Array<{ id: string; is_default: boolean }>;
  };
  const library = payload.data.find((candidate) => candidate.is_default);
  if (!library) throw new Error("Default library missing from E2E seed");
  return library.id;
}

async function createPage(page: Page): Promise<string> {
  const response = await page.request.post("/api/notes/pages", {
    headers: stateChangingApiHeaders(),
    data: { title: `E2E Resource Inspector ${Date.now()}` },
  });
  await expectOk(response, "Create Inspector page");
  return ((await response.json()) as { data: { id: string } }).data.id;
}

async function createConversation(page: Page): Promise<string> {
  const response = await page.request.post("/api/conversations", {
    headers: stateChangingApiHeaders(),
  });
  await expectOk(response, "Create Inspector conversation");
  return ((await response.json()) as { data: { id: string } }).data.id;
}

function runFixture(
  mode: "seed" | "cleanup",
  input: {
    ownerId: string;
    mediaId: string;
    pageId: string;
    fixture?: InspectorFixture;
  },
): InspectorFixture | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for the Resource Inspector fixture",
    );
  }
  const output = execFileSync(
    "uv",
    ["run", "--project", "python", "python", "e2e/seed-resource-inspector.py"],
    {
      cwd: ROOT_DIR,
      env: {
        ...childAppRuntimeEnv(),
        DATABASE_URL: databaseUrl.replace(
          /^postgresql:\/\//,
          "postgresql+psycopg://",
        ),
        NEXUS_E2E_RESOURCE_INSPECTOR_MODE: mode,
        NEXUS_E2E_OWNER_USER_ID: input.ownerId,
        NEXUS_E2E_MEDIA_ID: input.mediaId,
        NEXUS_E2E_PAGE_ID: input.pageId,
        ...(input.fixture
          ? {
              NEXUS_E2E_RESOURCE_INSPECTOR_FIXTURE: JSON.stringify(
                input.fixture,
              ),
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).toString("utf-8");
  if (mode === "cleanup") return null;
  const jsonLine = output.trim().split("\n").at(-1);
  if (!jsonLine) throw new Error("Resource Inspector seed produced no JSON");
  return JSON.parse(jsonLine) as InspectorFixture;
}

function visibleCompanion(page: Page): Locator {
  return page
    .getByRole("button", { name: "Companion" })
    .filter({ visible: true });
}

function visibleDesktopInspector(page: Page): Locator {
  return page.getByTestId("workspace-secondary-pane").filter({ visible: true });
}

async function openDossier(page: Page): Promise<Locator> {
  const inspector = visibleDesktopInspector(page);
  await expect(inspector).toBeVisible({ timeout: 15_000 });
  await inspector.getByRole("tab", { name: "Dossier" }).click();
  const dossier = inspector.getByTestId("resource-dossier-surface");
  await expect(dossier).toBeVisible({ timeout: 15_000 });
  return dossier;
}

test("all canonical resources share Companion and one real Dossier lifecycle at desktop and 390px", async ({
  page,
}, testInfo) => {
  test.slow();
  test.setTimeout(180_000);

  const mediaId = readMediaSeed().media_id;
  const viewerId = await ownerId(page);
  const libraryId = await defaultLibraryId(page);
  let pageId: string | null = null;
  let conversationId: string | null = null;
  let fixture: InspectorFixture | null = null;
  let productError: unknown = null;

  try {
    pageId = await createPage(page);
    conversationId = await createConversation(page);
    const seededFixture = runFixture("seed", {
      ownerId: viewerId,
      mediaId,
      pageId,
    });
    if (!seededFixture) {
      throw new Error("Resource Inspector fixture was not created");
    }
    fixture = seededFixture;

    const resources: ResourceUnderTest[] = [
      {
        name: "Media",
        href: `/media/${mediaId}`,
        linkedItemsTab: "Evidence",
      },
      {
        name: "Conversation",
        href: `/conversations/${conversationId}`,
        linkedItemsTab: "Context",
        extraTabs: ["Forks"],
      },
      {
        name: "Library",
        href: `/libraries/${libraryId}`,
        linkedItemsTab: "Connections",
      },
      {
        name: "Podcast",
        href: `/podcasts/${seededFixture.podcast_id}`,
        linkedItemsTab: "Connections",
      },
      {
        name: "Author",
        href: `/authors/${seededFixture.contributor_handle}`,
        linkedItemsTab: "Connections",
      },
      {
        name: "Page",
        href: `/pages/${pageId}`,
        linkedItemsTab: "Connections",
      },
      {
        name: "Note",
        href: `/notes/${seededFixture.note_id}`,
        linkedItemsTab: "Connections",
      },
    ];

    for (const resource of resources) {
      await test.step(`${resource.name} publishes the shared Companion`, async () => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await gotoSinglePaneWorkspace(
          page,
          `${workspaceE2eDeviceId(testInfo, "e2e-inspector")}-${resource.name.toLowerCase()}`,
          resource.href,
        );

        const companion = activeWorkspacePane(page)
          .getByTestId("pane-shell-chrome")
          .getByRole("button", { name: "Companion" })
          .filter({ visible: true });
        await expect(companion).toBeVisible({ timeout: 15_000 });
        await companion.click();

        const inspector = visibleDesktopInspector(page);
        await expect(inspector).toBeVisible({ timeout: 15_000 });
        await expect(
          inspector.getByRole("tab", { name: resource.linkedItemsTab }),
        ).toBeVisible();
        for (const tab of resource.extraTabs ?? []) {
          await expect(inspector.getByRole("tab", { name: tab })).toBeVisible();
        }
        const dossier = await openDossier(page);
        if (resource.name === "Media") {
          const mediaAbstract = dossier.getByRole("region", {
            name: "Media abstract",
          });
          await expect(mediaAbstract).toContainText(
            seededFixture.abstract_text,
          );
          await mediaAbstract
            .getByRole("button", { name: "View evidence" })
            .click();
          await expect(
            inspector.getByRole("tab", { name: "Evidence" }),
          ).toHaveAttribute("aria-selected", "true");
        }

        await visibleCompanion(page).click();
        await expect(inspector).toBeHidden();
      });
    }

    await test.step("manual regeneration reconnects, cancels, and retains history and citations", async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoSinglePaneWorkspace(
        page,
        `${workspaceE2eDeviceId(testInfo, "e2e-inspector")}-dossier`,
        `/pages/${pageId}`,
      );
      await visibleCompanion(page).click();
      let dossier = await openDossier(page);

      await expect(
        dossier.getByRole("heading", { name: "Current fixture dossier" }),
      ).toBeVisible();
      const older = dossier.getByRole("button", { name: "Older revision" });
      await expect(older).toBeEnabled({ timeout: 15_000 });
      await older.click();
      await expect(
        dossier.getByRole("heading", { name: "Earlier fixture dossier" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(dossier).toContainText("Viewing a past revision.");
      await dossier.getByRole("button", { name: "Current", exact: true }).click();
      await expect(
        dossier.getByRole("heading", { name: "Current fixture dossier" }),
      ).toBeVisible({ timeout: 15_000 });

      const streamRequests: string[] = [];
      page.on("request", (request) => {
        if (
          new URL(request.url()).pathname.includes("/stream/artifact-builds/")
        ) {
          streamRequests.push(request.url());
        }
      });

      await dossier
        .getByRole("textbox", { name: "Optional instruction" })
        .fill("Reconnect this manual regeneration");
      await dossier.getByRole("button", { name: "Regenerate" }).click();
      await expect(dossier.getByRole("button", { name: "Cancel" })).toBeVisible(
        {
          timeout: 15_000,
        },
      );
      await expect
        .poll(() => streamRequests.length, { timeout: 15_000 })
        .toBeGreaterThan(0);

      await visibleCompanion(page).click();
      await expect(visibleDesktopInspector(page)).toBeHidden();
      const streamsBeforeReopen = streamRequests.length;
      await visibleCompanion(page).click();
      dossier = await openDossier(page);
      await expect(dossier.getByRole("button", { name: "Cancel" })).toBeVisible(
        {
          timeout: 15_000,
        },
      );
      await expect
        .poll(() => streamRequests.length, { timeout: 15_000 })
        .toBeGreaterThan(streamsBeforeReopen);

      const cancelResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith("/cancel") &&
          response.request().method() === "POST",
      );
      await dossier.getByRole("button", { name: "Cancel" }).click();
      await expectOk(await cancelResponse, "Cancel Dossier generation");
      await expect(dossier.getByRole("status").first()).toContainText(
        "The last generation was canceled.",
        { timeout: 15_000 },
      );
      await expect(
        dossier.getByRole("heading", { name: "Current fixture dossier" }),
      ).toBeVisible();
      await expect(
        dossier.getByRole("button", { name: "Older revision" }),
      ).toBeEnabled();

      const paneCount = await page.locator("[data-pane-id]").count();
      await dossier
        .getByRole("link", { name: "Open citation 1" })
        .click({ modifiers: ["Shift"] });
      await expect(page.locator("[data-pane-id]")).toHaveCount(paneCount + 1);
      await expect(page).toHaveURL(new RegExp(`/media/${mediaId}$`));
    });

    await test.step("the same Inspector projects as the 390px shared mobile sheet", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await gotoSinglePaneWorkspace(
        page,
        `${workspaceE2eDeviceId(testInfo, "e2e-inspector")}-mobile`,
        `/media/${mediaId}`,
      );
      await visibleCompanion(page).click();

      const sheet = page.getByTestId("mobile-secondary-host");
      await expect(sheet).toBeVisible({ timeout: 15_000 });
      await sheet.getByRole("tab", { name: "Dossier" }).click();
      await expect(sheet).toHaveAttribute("aria-label", "Dossier");
      await expect(
        sheet.getByRole("region", { name: "Media abstract" }),
      ).toContainText(seededFixture.abstract_text);
      await expect
        .poll(() =>
          sheet.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.left >= -1 &&
              rect.top >= -1 &&
              rect.right <= window.innerWidth + 1 &&
              rect.bottom <= window.innerHeight + 1
            );
          }),
        )
        .toBe(true);
      await sheet.getByRole("button", { name: "Close Dossier" }).click();
      await expect(sheet).toBeHidden();
      await expect(visibleCompanion(page)).toBeFocused();
    });
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (fixture && pageId) {
      try {
        runFixture("cleanup", {
          ownerId: viewerId,
          mediaId,
          pageId,
          fixture,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (pageId) {
      try {
        const response = await page.request.delete(
          `/api/notes/pages/${pageId}`,
          {
            headers: stateChangingApiHeaders(),
          },
        );
        if (!response.ok() && response.status() !== 404) {
          throw new Error(
            `Delete Inspector page: ${response.status()} ${await response.text()}`,
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (conversationId) {
      try {
        const response = await page.request.delete(
          `/api/conversations/${conversationId}`,
          { headers: stateChangingApiHeaders() },
        );
        if (!response.ok() && response.status() !== 404) {
          throw new Error(
            `Delete Inspector conversation: ${response.status()} ${await response.text()}`,
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [productError, ...cleanupErrors].filter(
          (error): error is NonNullable<typeof error> => error != null,
        ),
        "Resource Inspector acceptance cleanup failed",
      );
    }
  }
});
