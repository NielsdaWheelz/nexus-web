import { expect, test, type Locator, type Page } from "@playwright/test";

interface LlmProfilesResponse {
  data: {
    default_profile_id: string | null;
    profiles: Array<{ id: string }>;
  };
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
  const profilesResponse = await page.request.get("/api/llm-profiles");
  const profilesBody = await profilesResponse.text();
  expect(
    profilesResponse.ok(),
    `GET /api/llm-profiles failed: status=${profilesResponse.status()}; body=${profilesBody.slice(0, 300)}`,
  ).toBeTruthy();

  const profilesPayload = JSON.parse(profilesBody) as LlmProfilesResponse;
  test.skip(profilesPayload.data.profiles.length === 0, skipReason);

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
