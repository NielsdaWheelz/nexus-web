import { expect, test, type Locator, type Page } from "@playwright/test";

interface LlmProfilesResponse {
  data: {
    default_profile_id: string;
    profiles: Array<{ id: string }>;
  };
}

export async function requireRunnableChatComposer({
  page,
  profilePicker,
  skipReason,
  timeout = 15_000,
}: {
  page: Page;
  profilePicker: Locator;
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

  const runnableProfileIds = new Set(
    profilesPayload.data.profiles.map((profile) => profile.id),
  );
  await expect(profilePicker).toBeVisible({ timeout });
  await expect
    .poll(
      async () => {
        const selectedProfileId = await profilePicker
          .inputValue()
          .catch(() => "");
        return runnableProfileIds.has(selectedProfileId);
      },
      { timeout },
    )
    .toBe(true);
}
