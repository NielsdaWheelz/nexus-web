import { expect, test, type Locator, type Page } from "@playwright/test";
import { stateChangingApiHeaders } from "./api";
import { seedScrollConversation } from "./conversation-tree-seed";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

const INITIAL_VIEWPORT = { width: 1_000, height: 300 };
const RESIZED_VIEWPORT = { width: 390, height: 300 };
const SETTINGS_SCOPE = '[data-pane-return-scope="Settings.Sections"]';
const CONVERSATIONS_SCOPE = '[data-pane-return-scope="Conversations.Items"]';
const BILLING_ROW_ID = "/settings/billing";
const APPEARANCE_ROW_ID = "/settings/appearance";
const TARGET_OFFSET_PX = -12;
const OFFSET_TOLERANCE_PX = 1;

function paneScrollport(page: Page): Locator {
  return activeWorkspacePane(page).getByTestId("pane-shell-body");
}

function settingsRow(page: Page, rowId: string): Locator {
  return activeWorkspacePane(page)
    .locator(SETTINGS_SCOPE)
    .locator(`[data-collection-row-id="${rowId}"]`);
}

function collectionRow(page: Page, scope: string, rowId: string): Locator {
  return activeWorkspacePane(page)
    .locator(scope)
    .locator(`[data-collection-row-id="${rowId}"]`);
}

function primaryNavigation(page: Page): Locator {
  return page.getByRole("navigation", { name: "Primary" });
}

async function placeRowAtOffset(
  row: Locator,
  offsetPx: number,
): Promise<void> {
  await expect
    .poll(() =>
      row.evaluate((target, nextOffsetPx) => {
        if (!target.isConnected) {
          return false;
        }
        const element = target.closest<HTMLElement>(
          '[data-testid="pane-shell-body"]',
        );
        if (!element?.isConnected) {
          return false;
        }
        const viewport = element.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        element.scrollTop += targetRect.top - viewport.top - nextOffsetPx;
        return true;
      }, offsetPx),
    )
    .toBe(true);
}

async function rowViewportOffset(row: Locator): Promise<number> {
  let resolvedOffset: number | null = null;
  await expect
    .poll(async () => {
      resolvedOffset = await row.evaluate((target) => {
        if (!target.isConnected) {
          return null;
        }
        const element = target.closest<HTMLElement>(
          '[data-testid="pane-shell-body"]',
        );
        if (!element?.isConnected) {
          return null;
        }
        return (
          target.getBoundingClientRect().top -
          element.getBoundingClientRect().top
        );
      });
      return resolvedOffset;
    })
    .not.toBeNull();
  return resolvedOffset!;
}

async function firstIntersectingRowId(
  scrollport: Locator,
  scope: string,
): Promise<string> {
  return scrollport.evaluate((element, scopeSelector) => {
    const scopeRoot = element.querySelector<HTMLElement>(scopeSelector);
    if (!scopeRoot) {
      throw new Error(`Missing pane-return scope ${scopeSelector}`);
    }
    const viewport = element.getBoundingClientRect();
    for (const candidate of scopeRoot.querySelectorAll<HTMLElement>(
      "[data-collection-row-id]",
    )) {
      const rect = candidate.getBoundingClientRect();
      if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
        const id = candidate.dataset.collectionRowId;
        if (id) return id;
      }
    }
    throw new Error(`No intersecting row in ${scopeSelector}`);
  }, scope);
}

async function expectRowRestoredAtClampedOffset(
  scrollport: Locator,
  row: Locator,
  expectedRowId: string,
  desiredOffsetPx: number,
): Promise<void> {
  await expect
    .poll(() =>
      row.evaluate(
        (target, desiredOffsetPx) => {
          if (!target.isConnected) {
            return Number.POSITIVE_INFINITY;
          }
          const element = target.closest<HTMLElement>(
            '[data-testid="pane-shell-body"]',
          );
          if (!element?.isConnected) {
            return Number.POSITIVE_INFINITY;
          }
          const viewport = element.getBoundingClientRect();
          const actualOffsetPx =
            target.getBoundingClientRect().top - viewport.top;
          const targetOffsetPx = actualOffsetPx + element.scrollTop;
          const desiredScrollTop = targetOffsetPx - desiredOffsetPx;
          const maxScrollTop = Math.max(
            0,
            element.scrollHeight - element.clientHeight,
          );
          const clampedScrollTop = Math.min(
            Math.max(0, desiredScrollTop),
            maxScrollTop,
          );
          return Math.abs(actualOffsetPx - (targetOffsetPx - clampedScrollTop));
        },
        desiredOffsetPx,
      ),
    )
    .toBeLessThanOrEqual(OFFSET_TOLERANCE_PX);
  await expect
    .poll(() =>
      scrollport.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        for (const candidate of element.querySelectorAll<HTMLElement>(
          "[data-collection-row-id]",
        )) {
          const rect = candidate.getBoundingClientRect();
          if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
            return candidate.dataset.collectionRowId ?? null;
          }
        }
        return null;
      }),
    )
    .toBe(expectedRowId);
}

async function expectRowRestored(
  row: Locator,
  expectedRowId: string,
  expectedOffsetPx: number,
): Promise<void> {
  await expect(row).toHaveAttribute("data-collection-row-id", expectedRowId);
  await expect
    .poll(() => rowViewportOffset(row))
    .toBeGreaterThanOrEqual(expectedOffsetPx - OFFSET_TOLERANCE_PX);
  await expect
    .poll(() => rowViewportOffset(row))
    .toBeLessThanOrEqual(expectedOffsetPx + OFFSET_TOLERANCE_PX);
}

async function goBackInPane(
  page: Page,
  expectedPath: RegExp = /\/settings$/,
): Promise<void> {
  const back = page
    .getByRole("button", { name: /^Go back(?: in this pane)?$/ })
    .filter({ visible: true });
  await expect(back).toHaveCount(1);
  await expect(back).toBeEnabled();
  await back.click();
  await expect(page).toHaveURL(expectedPath);
}

async function createConversation(page: Page): Promise<string> {
  const response = await page.request.post("/api/conversations", {
    headers: stateChangingApiHeaders(),
  });
  const body = await response.text();
  expect(
    response.ok(),
    `POST /api/conversations failed: ${response.status()} ${body.slice(0, 300)}`,
  ).toBeTruthy();
  return (JSON.parse(body) as { data: { id: string } }).data.id;
}

async function createConversations(
  page: Page,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let start = 0; start < count; start += 5) {
    ids.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(5, count - start) }, () =>
          createConversation(page),
        ),
      )),
    );
  }
  return ids;
}

async function deleteConversations(
  page: Page,
  conversationIds: readonly string[],
): Promise<void> {
  for (let start = 0; start < conversationIds.length; start += 5) {
    await Promise.all(
      conversationIds.slice(start, start + 5).map(async (conversationId) => {
        const response = await page.request.delete(
          `/api/conversations/${conversationId}`,
          { headers: stateChangingApiHeaders() },
        );
        expect(
          response.ok() || response.status() === 404,
          `DELETE /api/conversations/${conversationId} failed: ${response.status()}`,
        ).toBeTruthy();
      }),
    );
  }
}

test.describe("pane return memento", () => {
  test.use({ viewport: INITIAL_VIEWPORT });

  test("restores a semantic eye-line and independent keyboard focus after resize", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-pane-return"),
      "/settings",
    );

    const eyeLineRow = settingsRow(page, BILLING_ROW_ID);
    const focusedRowLink = settingsRow(page, APPEARANCE_ROW_ID).locator(
      "[data-row-focusable]",
    );
    await expect(eyeLineRow).toBeVisible();
    await placeRowAtOffset(eyeLineRow, TARGET_OFFSET_PX);

    const capturedOffsetPx = await rowViewportOffset(eyeLineRow);
    expect(capturedOffsetPx).toBeLessThan(0);
    await expectRowRestored(
      eyeLineRow,
      BILLING_ROW_ID,
      capturedOffsetPx,
    );
    await expect(focusedRowLink).toBeInViewport();
    await focusedRowLink.focus();
    await expect(focusedRowLink).toBeFocused();

    await focusedRowLink.press("Enter");
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expect(
      activeWorkspacePane(page).getByRole("heading", { name: "Appearance" }),
    ).toBeVisible();

    await page.setViewportSize(RESIZED_VIEWPORT);
    await goBackInPane(page);

    const restoredScrollport = paneScrollport(page);
    const restoredEyeLineRow = settingsRow(page, BILLING_ROW_ID);
    await expect(restoredEyeLineRow).toBeVisible();
    await expectRowRestoredAtClampedOffset(
      restoredScrollport,
      restoredEyeLineRow,
      BILLING_ROW_ID,
      capturedOffsetPx,
    );
    await expect(
      settingsRow(page, APPEARANCE_ROW_ID).locator("[data-row-focusable]"),
    ).toBeFocused();
  });

  test("a pointer journey restores the eye-line without moving focus to its row", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-pane-return"),
      "/settings",
    );

    const eyeLineRow = settingsRow(page, BILLING_ROW_ID);
    const pointerTarget = settingsRow(page, APPEARANCE_ROW_ID).locator(
      "[data-row-focusable]",
    );
    await expect(eyeLineRow).toBeVisible();
    await placeRowAtOffset(eyeLineRow, TARGET_OFFSET_PX);
    const capturedOffsetPx = await rowViewportOffset(eyeLineRow);
    await expectRowRestored(
      eyeLineRow,
      BILLING_ROW_ID,
      capturedOffsetPx,
    );

    await pointerTarget.click();
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await goBackInPane(page);

    const restoredEyeLineRow = settingsRow(page, BILLING_ROW_ID);
    await expectRowRestored(
      restoredEyeLineRow,
      BILLING_ROW_ID,
      capturedOffsetPx,
    );
    await expect(pointerTarget).not.toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement
              ?.closest("[data-collection-row-id]")
              ?.getAttribute("data-collection-row-id") ?? null,
        ),
      )
      .toBeNull();
  });

  test("Conversations restores appended extent and eye-line while transcript scroll remains Chat-owned", async ({
    page,
  }, testInfo) => {
    test.slow();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-pane-return-conversations"),
      "/settings",
    );
    const target = await seedScrollConversation(page, 50);
    const conversationIds = [target.conversation_id];
    try {
      const firstPageConversationIds = await createConversations(page, 50);
      conversationIds.push(...firstPageConversationIds);
      await primaryNavigation(page)
        .getByRole("link", { name: "Chats" })
        .click();
      await expect(page).toHaveURL(/\/conversations$/);
      await activeWorkspacePane(page)
        .getByRole("button", { name: "Load more conversations" })
        .click();

      const listScrollport = paneScrollport(page);
      const targetConversation = collectionRow(
        page,
        CONVERSATIONS_SCOPE,
        target.conversation_id,
      );
      await expect(targetConversation).toBeVisible();
      await placeRowAtOffset(targetConversation, TARGET_OFFSET_PX);
      const targetLink = targetConversation.locator("[data-row-focusable]");
      await expect(targetLink).toBeInViewport({ ratio: 1 });
      // Finish actionability before capturing both the return memento and the
      // raw pointer target. A same-document view transition temporarily owns
      // hit testing, and hover can scroll while waiting for that layer to clear.
      await targetLink.hover();
      const conversationEyeLineId = await firstIntersectingRowId(
        listScrollport,
        CONVERSATIONS_SCOPE,
      );
      const conversationOffset = await rowViewportOffset(
        collectionRow(page, CONVERSATIONS_SCOPE, conversationEyeLineId),
      );
      const targetLinkBox = await targetLink.boundingBox();
      expect(targetLinkBox).not.toBeNull();
      await page.mouse.click(
        targetLinkBox!.x + targetLinkBox!.width / 2,
        targetLinkBox!.y + targetLinkBox!.height / 2,
      );
      await expect(page).toHaveURL(
        new RegExp(`/conversations/${target.conversation_id}$`),
      );

      const chatScrollport = activeWorkspacePane(page).getByRole("region", {
        name: "Chat conversation",
      });
      await expect(chatScrollport).toBeVisible();
      await expect(
        activeWorkspacePane(page).getByRole("log", {
          name: "Chat messages",
        }),
      ).toContainText(`Scroll fixture message ${target.message_count}`);
      await chatScrollport.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() =>
          chatScrollport.evaluate(
            (element) =>
              element.scrollHeight > element.clientHeight &&
              element.scrollTop > 0,
          ),
        )
        .toBe(true);
      await expect(paneScrollport(page)).toHaveAttribute(
        "data-body-mode",
        "contained",
      );
      expect(
        await paneScrollport(page).evaluate((element) => element.scrollTop),
      ).toBe(0);

      await goBackInPane(page, /\/conversations$/);
      await expect(
        collectionRow(page, CONVERSATIONS_SCOPE, target.conversation_id),
      ).toHaveCount(1);
      await expect(
        collectionRow(page, CONVERSATIONS_SCOPE, firstPageConversationIds[0]!),
      ).toHaveCount(1);
      await expectRowRestored(
        collectionRow(page, CONVERSATIONS_SCOPE, conversationEyeLineId),
        conversationEyeLineId,
        conversationOffset,
      );
    } finally {
      await deleteConversations(page, conversationIds);
    }
  });
});
