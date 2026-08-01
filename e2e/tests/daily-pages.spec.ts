import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

type DailyPageDescriptor =
  | {
      kind: "Latent";
      localDate: string;
      defaultTitle: string;
    }
  | {
      kind: "Materialized";
      localDate: string;
      page: { id: string };
      surface: {
        ordered_items: Array<{
          target: {
            content:
              { kind: "note_body"; body_text: string } | { kind: string };
          };
        }>;
      };
    };

async function readDailyPage(
  request: APIRequestContext,
  localDate: string,
): Promise<DailyPageDescriptor> {
  const response = await request.get(`/api/notes/daily/${localDate}`);
  if (!response.ok()) {
    throw new Error(
      `Read daily Page failed: ${response.status()} ${response.statusText()} ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as { data: DailyPageDescriptor };
  return payload.data;
}

function bodyTextCount(
  descriptor: DailyPageDescriptor,
  expected: string,
): number {
  if (descriptor.kind !== "Materialized") return 0;
  return descriptor.surface.ordered_items.filter(
    ({ target }) =>
      target.content.kind === "note_body" &&
      "body_text" in target.content &&
      target.content.body_text === expected,
  ).length;
}

test.describe("daily Pages", () => {
  test("desktop Quick Note persists once through authenticated reload", async ({
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
    await page.clock.setFixedTime(new Date("2099-06-15T12:00:00Z"));
    const noteText = `E2E daily Quick Note ${randomUUID()}`;
    let localDate: string | null = null;
    let ownsDailyPage = false;
    let pageId: string | null = null;
    let productError: unknown = null;

    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-daily-page"),
        "/libraries",
      );
      await page
        .getByRole("button", { name: "Search or ask anything" })
        .click();
      const nexus = page.getByRole("dialog", { name: "Nexus" });
      await expect(
        nexus.getByRole("combobox", { name: "Find anything" }),
      ).toBeFocused();
      await nexus
        .locator(
          '[role="rowgroup"][aria-labelledby="desktop-nexus-section-QuickActions"]',
        )
        .getByRole("gridcell", { name: /^Quick Note\b/ })
        .click();

      await expect(page).toHaveURL(/\/daily\/\d{4}-\d{2}-\d{2}(?:[?#]|$)/);
      localDate =
        /^\/daily\/(\d{4}-\d{2}-\d{2})$/.exec(
          new URL(page.url()).pathname,
        )?.[1] ?? null;
      expect(localDate).toMatch(/^2099-06-1[56]$/);
      if (!localDate)
        throw new Error("Quick Note did not expose its local date");

      const before = await readDailyPage(page.request, localDate);
      expect(before.kind).toBe("Latent");
      ownsDailyPage = before.kind === "Latent";

      const editor = activeWorkspacePane(page).getByRole("textbox", {
        name: "Edit note 1",
      });
      await expect(editor).toBeFocused({ timeout: 15_000 });
      await page.keyboard.insertText(noteText);

      await expect
        .poll(
          async () =>
            bodyTextCount(
              await readDailyPage(page.request, localDate!),
              noteText,
            ),
          { timeout: 20_000 },
        )
        .toBe(1);

      const saved = await readDailyPage(page.request, localDate);
      if (saved.kind !== "Materialized") {
        throw new Error("Quick Note did not materialize its daily Page");
      }
      pageId = saved.page.id;
      expect(saved.surface.ordered_items).toHaveLength(1);

      await page.reload({ waitUntil: "domcontentloaded" });
      const reloadedEditor = activeWorkspacePane(page).getByRole("textbox", {
        name: "Edit note 1",
      });
      await expect(reloadedEditor).toContainText(noteText, {
        timeout: 15_000,
      });
      expect(
        bodyTextCount(await readDailyPage(page.request, localDate), noteText),
      ).toBe(1);
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (ownsDailyPage && localDate) {
        try {
          if (!pageId) {
            const descriptor = await readDailyPage(page.request, localDate);
            pageId =
              descriptor.kind === "Materialized" ? descriptor.page.id : null;
          }
          if (pageId) {
            await deleteE2eResource(
              page.request,
              `/api/notes/pages/${pageId}`,
              `Daily Page ${pageId}`,
            );
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (browserErrors.length > 0) {
        await testInfo.attach("browser-errors.txt", {
          body: browserErrors.join("\n\n"),
          contentType: "text/plain",
        });
      }
      throwE2eCleanupFailures(
        "Daily Page Quick Note",
        productError,
        cleanupErrors,
      );
    }
  });
});
