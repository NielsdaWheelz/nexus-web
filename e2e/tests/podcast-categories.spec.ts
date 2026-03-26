import { test, expect, type Locator, type Page, type Response } from "@playwright/test";

interface PodcastCategoryPayload {
  id: string;
  name: string;
}

async function createCategoryViaUi(
  page: Page,
  name: string,
  color: string
): Promise<PodcastCategoryPayload> {
  await page.getByRole("button", { name: "New category", exact: true }).click();
  await page.getByLabel("Category name").fill(name);
  await page.getByLabel("Category color").fill(color);

  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/podcasts/categories" && response.request().method() === "POST";
  });
  await page.getByRole("button", { name: "Create category", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { data: PodcastCategoryPayload };
  await expect(page.getByRole("button", { name: `Reorder category ${name}` })).toBeVisible({
    timeout: 15_000,
  });
  return payload.data;
}

async function dragHandleBelowTarget(
  page: Page,
  sourceHandle: Locator,
  targetHandle: Locator
): Promise<void> {
  await sourceHandle.scrollIntoViewIfNeeded();
  await targetHandle.scrollIntoViewIfNeeded();
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Unable to compute drag handle bounds for reorder action");
  }

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height + Math.max(targetBox.height / 2, 8),
    { steps: 18 }
  );
  await page.mouse.up();
}

async function reorderCategoriesViaUi(
  page: Page,
  sourceHandle: Locator,
  targetHandle: Locator
): Promise<Response> {
  const waitForReorderResponse = () =>
    page
      .waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/podcasts/categories/order" &&
            response.request().method() === "PUT"
          );
        },
        { timeout: 7_000 }
      )
      .catch(() => null);

  const manualResponsePromise = waitForReorderResponse();
  await dragHandleBelowTarget(page, sourceHandle, targetHandle);
  const manualResponse = await manualResponsePromise;
  if (manualResponse) {
    return manualResponse;
  }

  const fallbackResponsePromise = waitForReorderResponse();
  await sourceHandle.dragTo(targetHandle, {
    targetPosition: { x: 12, y: 12 },
  });
  const fallbackResponse = await fallbackResponsePromise;
  if (fallbackResponse) {
    return fallbackResponse;
  }

  throw new Error("Reorder request was not observed after drag attempts");
}

test.describe("podcast categories", () => {
  test("drag reorder persists category order", async ({ page }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const firstName = `E2E Drag A ${suffix}`;
    const secondName = `E2E Drag B ${suffix}`;
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });
    try {
      await page.goto("/podcasts/subscriptions");
      const categoriesStatus = await page.evaluate(async () => {
        const response = await fetch("/api/podcasts/categories", { credentials: "include" });
        return response.status;
      });
      test.skip(
        categoriesStatus === 404,
        "podcast categories API is disabled in this environment (expected when podcasts_enabled=false)"
      );
      expect(categoriesStatus).toBe(200);

      const first = await createCategoryViaUi(page, firstName, "#6633FF");
      const second = await createCategoryViaUi(page, secondName, "#228855");
      const firstHandle = page.getByRole("button", { name: `Reorder category ${firstName}` });
      const secondHandle = page.getByRole("button", { name: `Reorder category ${secondName}` });

      await expect(firstHandle).toBeVisible({ timeout: 15_000 });
      await expect(secondHandle).toBeVisible({ timeout: 15_000 });
      await firstHandle.scrollIntoViewIfNeeded();
      await secondHandle.scrollIntoViewIfNeeded();

      const reorderResponse = await reorderCategoriesViaUi(page, firstHandle, secondHandle);
      expect(reorderResponse.ok()).toBeTruthy();

      const reorderBody = reorderResponse.request().postDataJSON() as { category_ids: string[] };
      expect(Array.isArray(reorderBody.category_ids)).toBeTruthy();
      const reorderedFirstIndex = reorderBody.category_ids.indexOf(first.id);
      const reorderedSecondIndex = reorderBody.category_ids.indexOf(second.id);
      expect(reorderedFirstIndex).toBeGreaterThan(-1);
      expect(reorderedSecondIndex).toBeGreaterThan(-1);
      expect(reorderedFirstIndex).toBeGreaterThan(reorderedSecondIndex);

      await page.reload();
      const reorderHandles = page.getByRole("button", { name: /Reorder category / });
      await expect(reorderHandles.first()).toBeVisible();
      const labels = await reorderHandles.all();
      const labelTexts = await Promise.all(labels.map((handle) => handle.getAttribute("aria-label")));
      const persistedFirstIndex = labelTexts.findIndex(
        (label) => label === `Reorder category ${firstName}`
      );
      const persistedSecondIndex = labelTexts.findIndex(
        (label) => label === `Reorder category ${secondName}`
      );
      expect(persistedFirstIndex).toBeGreaterThan(-1);
      expect(persistedSecondIndex).toBeGreaterThan(-1);
      expect(persistedFirstIndex).toBeGreaterThan(persistedSecondIndex);
    } finally {
      if (page.isClosed()) {
        return;
      }
      const deleteCategoryNames = [firstName, secondName];
      for (const categoryName of deleteCategoryNames) {
        const deleteButton = page.getByRole("button", { name: `Delete category ${categoryName}` });
        if ((await deleteButton.count()) === 0) {
          continue;
        }
        const deleteResponsePromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname.includes("/api/podcasts/categories/") && response.request().method() === "DELETE";
        });
        await deleteButton.first().click();
        await deleteResponsePromise;
      }
    }
  });
});
