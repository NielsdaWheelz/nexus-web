import { expect, test, type Locator, type Page } from "@playwright/test";

interface ModelsResponse {
  data: Array<{ id: string }>;
}

export async function requireRunnableChatComposer({
  page,
  modelSettings,
  skipReason,
  timeout = 15_000,
}: {
  page: Page;
  modelSettings: Locator;
  skipReason: string;
  timeout?: number;
}): Promise<void> {
  const modelsResponse = await page.request.get("/api/models");
  const modelsBody = await modelsResponse.text();
  expect(
    modelsResponse.ok(),
    `GET /api/models failed: status=${modelsResponse.status()}; body=${modelsBody.slice(0, 300)}`,
  ).toBeTruthy();

  const modelsPayload = JSON.parse(modelsBody) as ModelsResponse;
  test.skip(modelsPayload.data.length === 0, skipReason);

  await expect(modelSettings).toBeVisible();
  await expect
    .poll(
      async () => {
        const modelLabel = await modelSettings
          .getAttribute("aria-label")
          .catch(() => "");
        return Boolean(modelLabel && modelLabel !== "Model settings: Model");
      },
      { timeout },
    )
    .toBe(true);
}
