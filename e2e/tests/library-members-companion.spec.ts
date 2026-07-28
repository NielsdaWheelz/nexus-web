import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import { bootstrapMagicLinkSessionForEmail } from "./auth-bootstrap";
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

interface LibraryMembersFixture {
  library_id: string;
  system_library_id: string;
  library_name: string;
  email_prefix: string;
  candidate_email: string;
  candidate_name: string;
  member_count: number;
  pending_invitation_count: number;
}

interface Viewer {
  user_id: string;
  default_library_id: string;
  email: string | null;
}

interface SearchUser {
  userHandle: string;
  email: { kind: "Absent" } | { kind: "Present"; value: string };
}

function childAppRuntimeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SCRIPT_ONLY_SECRET_KEYS) delete env[key];
  return env;
}

function runFixture(
  mode: "seed" | "cleanup" | "add-member",
  input: {
    ownerId?: string;
    fixture?: LibraryMembersFixture;
    memberUserId?: string;
    memberRole?: "admin" | "member";
  },
): LibraryMembersFixture | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the Library Members fixture");
  }
  const output = execFileSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "e2e/seed-library-members-companion.py",
    ],
    {
      cwd: ROOT_DIR,
      env: {
        ...childAppRuntimeEnv(),
        DATABASE_URL: databaseUrl.replace(
          /^postgresql:\/\//,
          "postgresql+psycopg://",
        ),
        NEXUS_E2E_LIBRARY_MEMBERS_MODE: mode,
        ...(input.ownerId ? { NEXUS_E2E_OWNER_USER_ID: input.ownerId } : {}),
        ...(input.fixture
          ? {
              NEXUS_E2E_LIBRARY_MEMBERS_FIXTURE: JSON.stringify(input.fixture),
            }
          : {}),
        ...(input.memberUserId
          ? { NEXUS_E2E_MEMBER_USER_ID: input.memberUserId }
          : {}),
        ...(input.memberRole
          ? { NEXUS_E2E_LIBRARY_MEMBER_ROLE: input.memberRole }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).toString("utf-8");
  if (mode !== "seed") return null;
  const jsonLine = output.trim().split("\n").at(-1);
  if (!jsonLine) throw new Error("Library Members seed produced no JSON");
  return JSON.parse(jsonLine) as LibraryMembersFixture;
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

async function readViewer(page: Page): Promise<Viewer> {
  const response = await page.request.get("/api/me");
  await expectOk(response, "Read E2E viewer");
  return ((await response.json()) as { data: Viewer }).data;
}

async function bootstrapUser(
  browser: Browser,
  request: APIRequestContext,
  email: string,
): Promise<{ context: BrowserContext; page: Page; viewer: Viewer }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await bootstrapMagicLinkSessionForEmail(page, request, email);
  return { context, page, viewer: await readViewer(page) };
}

async function findUser(page: Page, email: string): Promise<SearchUser> {
  const response = await page.request.get(
    `/api/users/search?q=${encodeURIComponent(email)}`,
  );
  await expectOk(response, `Find ${email}`);
  const payload = (await response.json()) as { data: SearchUser[] };
  const user = payload.data.find(
    (candidate) =>
      candidate.email.kind === "Present" && candidate.email.value === email,
  );
  if (!user) throw new Error(`No exact user-search result for ${email}`);
  return user;
}

function grantShareEntitlement(email: string): void {
  const env = { ...process.env };
  delete env.SUPABASE_AUTH_ADMIN_KEY;
  execFileSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "-m",
      "nexus.ops.entitlement_overrides",
      "grant",
      "--email",
      email,
      "--plan",
      "ai_plus",
      "--reason",
      "Library Members Companion E2E",
      "--actor-label",
      "playwright",
    ],
    {
      cwd: ROOT_DIR,
      env,
      stdio: "pipe",
    },
  );
}

function visibleCompanion(page: Page): Locator {
  return page
    .getByRole("button", { name: "Companion" })
    .filter({ visible: true });
}

async function openShare(page: Page, paneDefects: string[]): Promise<Locator> {
  const options = page
    .getByRole("button", { name: /^(?:Options|Pane options)$/ })
    .filter({ visible: true })
    .first();
  await expect(options).toBeVisible({ timeout: 15_000 });
  try {
    await options.click({ timeout: 15_000 });
  } catch (error) {
    if (
      await page
        .getByRole("region", { name: "Pane failed to render" })
        .isVisible()
        .catch(() => false)
    ) {
      throw new Error(
        `Library pane crashed while opening Share: ${
          paneDefects.at(-1) ?? "no browser defect detail was published"
        }`,
        { cause: error },
      );
    }
    throw error;
  }
  await page.getByRole("menuitem", { name: "Share…" }).click();
  const share = page
    .getByRole("dialog", { name: "Share" })
    .filter({ visible: true });
  await expect(share).toBeVisible();
  return share;
}

async function openLibrary(
  page: Page,
  testInfo: TestInfo,
  suffix: string,
  libraryId: string,
): Promise<void> {
  await gotoSinglePaneWorkspace(
    page,
    workspaceE2eDeviceId(testInfo, `e2e-library-members-${suffix}`),
    `/libraries/${libraryId}`,
  );
}

async function exhaustPagination(
  surface: Locator,
  buttonName: string,
  rowName: RegExp,
): Promise<void> {
  for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
    const button = surface.getByRole("button", { name: buttonName });
    if ((await button.count()) === 0) return;
    const rows = surface.getByText(rowName);
    const priorRowCount = await rows.count();
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(priorRowCount);
  }
  throw new Error(`${buttonName} remained after five page requests`);
}

test("Library Members is the sole complete governance surface across desktop and mobile", async ({
  browser,
  page,
  request,
}, testInfo) => {
  test.slow();
  test.setTimeout(240_000);

  const owner = await readViewer(page);
  let fixture: LibraryMembersFixture | null = null;
  let secondary: Awaited<ReturnType<typeof bootstrapUser>> | null = null;
  let productError: unknown = null;
  const paneDefects: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().startsWith("Workspace pane ")
    ) {
      paneDefects.push(message.text());
    }
  });

  try {
    if (!owner.email) throw new Error("E2E owner has no account email");
    grantShareEntitlement(owner.email);
    fixture = runFixture("seed", { ownerId: owner.user_id });
    if (!fixture) throw new Error("Library Members fixture was not created");

    const secondaryEmail = "e2e-library-members-secondary@nexus.local";
    secondary = await bootstrapUser(browser, request, secondaryEmail);
    runFixture("add-member", {
      fixture,
      memberUserId: secondary.viewer.user_id,
      memberRole: "admin",
    });
    const secondaryUser = await findUser(page, secondaryEmail);

    await test.step("desktop Share opens an authorized, cursor-complete Members Companion", async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openLibrary(page, testInfo, "owner-desktop", fixture!.library_id);
      const share = await openShare(page, paneDefects);
      await share.getByRole("button", { name: "Manage members" }).click();
      await expect(share).toBeHidden();

      const companion = page
        .getByTestId("workspace-secondary-pane")
        .filter({ visible: true });
      await expect(companion).toBeVisible({ timeout: 15_000 });
      await expect(companion.getByRole("tab")).toHaveText([
        "Members",
        "Connections",
        "Dossier",
      ]);
      await expect(
        companion.getByRole("tab", { name: "Members" }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        companion.getByRole("heading", { name: "Members" }),
      ).toBeVisible();

      await exhaustPagination(companion, "Load more members", /^Member \d{3}$/);
      await expect(companion.getByText(/^Member \d{3}$/)).toHaveCount(205);
      await exhaustPagination(
        companion,
        "Load more invitations",
        /^Invitee \d{3}$/,
      );
      await expect(companion.getByText(/^Invitee \d{3}$/)).toHaveCount(205);

      const search = companion.getByRole("combobox", {
        name: "Find an existing Nexus user by name or account email",
      });
      await search.fill(fixture!.candidate_email);
      await companion
        .getByRole("option", { name: new RegExp(fixture!.candidate_name) })
        .click();
      await companion.getByRole("tab", { name: "Connections" }).click();
      await companion.getByRole("tab", { name: "Members" }).click();
      await expect(search).toHaveValue(fixture!.candidate_name);
      await expect(companion.getByText(/^Member \d{3}$/)).toHaveCount(205);
      const invite = companion.getByRole("button", {
        name: "Invite",
        exact: true,
      });
      await expect(invite).toBeEnabled();
      await invite.click();
      await expect(
        companion.getByText(/Invitation created.*no email was sent/i),
      ).toBeVisible();
      await expect(
        companion.getByText(fixture!.candidate_name, { exact: true }),
      ).toBeVisible();
    });

    await test.step("mobile Share activates the same Members surface", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openLibrary(page, testInfo, "owner-mobile", fixture!.library_id);
      const share = await openShare(page, paneDefects);
      await share.getByRole("button", { name: "Manage members" }).click();
      await expect(share).toBeHidden();

      const companion = page.getByTestId("mobile-secondary-host");
      await expect(companion).toBeVisible({ timeout: 15_000 });
      await expect(companion).toHaveAttribute("aria-label", "Members");
      await expect(
        companion.getByRole("tab", { name: "Members" }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        companion.getByRole("heading", { name: "Members" }),
      ).toBeVisible();
    });

    await test.step("default and system Libraries publish no Members affordance", async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const [kind, libraryId] of [
        ["default", owner.default_library_id],
        ["system", fixture!.system_library_id],
      ] as const) {
        await openLibrary(page, testInfo, `owner-${kind}`, libraryId);
        await visibleCompanion(page).click();
        const companion = page
          .getByTestId("workspace-secondary-pane")
          .filter({ visible: true });
        await expect(companion).toBeVisible();
        await expect(
          companion.getByRole("tab", { name: "Members" }),
        ).toHaveCount(0);

        const capabilityResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "GET" &&
            new URL(response.url()).pathname === `/api/libraries/${libraryId}`,
        );
        const share = await openShare(page, paneDefects);
        await expectOk(
          await capabilityResponse,
          `Read ${kind} Library capability`,
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await expect(
          share.getByRole("button", { name: "Manage members" }),
        ).toHaveCount(0);
        await expect(
          share.getByRole("heading", { name: "People" }),
        ).toHaveCount(0);
        await share.getByRole("button", { name: "Close dialog" }).click();
      }
    });

    await test.step("observed authority and membership loss remove stale governance", async () => {
      await secondary!.page.setViewportSize({ width: 1280, height: 800 });
      await openLibrary(
        secondary!.page,
        testInfo,
        "secondary-admin",
        fixture!.library_id,
      );
      await visibleCompanion(secondary!.page).click();
      let companion = secondary!.page
        .getByTestId("workspace-secondary-pane")
        .filter({ visible: true });
      await companion.getByRole("tab", { name: "Members" }).click();
      await expect(
        companion.getByRole("heading", { name: "Members" }),
      ).toBeVisible();

      const demote = await page.request.patch(
        `/api/libraries/${fixture!.library_id}/members/${encodeURIComponent(
          secondaryUser.userHandle,
        )}`,
        {
          headers: stateChangingApiHeaders(),
          data: { role: "member" },
        },
      );
      await expectOk(demote, "Demote secondary admin");

      await companion.getByRole("tab", { name: "Dossier" }).click();
      await companion.getByRole("tab", { name: "Members" }).click();
      await expect(companion.getByRole("tab", { name: "Members" })).toHaveCount(
        0,
      );
      await expect(
        companion.getByRole("tab", { name: "Dossier" }),
      ).toHaveAttribute("aria-selected", "true");

      const ordinaryShare = await openShare(secondary!.page, paneDefects);
      await expect(ordinaryShare).toContainText(
        "Members are managed by library admins.",
      );
      await expect(
        ordinaryShare.getByRole("button", { name: "Manage members" }),
      ).toHaveCount(0);
      await ordinaryShare.getByRole("button", { name: "Close dialog" }).click();

      runFixture("add-member", {
        fixture: fixture!,
        memberUserId: secondary!.viewer.user_id,
        memberRole: "admin",
      });
      await openLibrary(
        secondary!.page,
        testInfo,
        "secondary-membership-loss",
        fixture!.library_id,
      );
      await visibleCompanion(secondary!.page).click();
      companion = secondary!.page
        .getByTestId("workspace-secondary-pane")
        .filter({ visible: true });
      await companion.getByRole("tab", { name: "Members" }).click();
      await expect(
        companion.getByRole("heading", { name: "Members" }),
      ).toBeVisible();

      const remove = await page.request.delete(
        `/api/libraries/${fixture!.library_id}/members/${encodeURIComponent(
          secondaryUser.userHandle,
        )}`,
        { headers: stateChangingApiHeaders() },
      );
      expect(remove.status(), await remove.text()).toBe(204);

      await companion.getByRole("tab", { name: "Dossier" }).click();
      await companion.getByRole("tab", { name: "Members" }).click();
      await expect(
        activeWorkspacePane(secondary!.page).getByText("Library not found"),
      ).toBeVisible({ timeout: 15_000 });
      companion = secondary!.page
        .getByTestId("workspace-secondary-pane")
        .filter({ visible: true });
      await expect(companion).toHaveCount(0);
    });
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (secondary) {
      try {
        await secondary.context.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (fixture) {
      try {
        runFixture("cleanup", { fixture });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0 && productError === null) {
      throw cleanupErrors[0];
    }
  }
});
