import { test, expect, type Page } from "@playwright/test";

interface ApiKey {
  provider: string;
  fingerprint?: string | null;
  key_fingerprint?: string | null;
}

test.describe("api keys", () => {
  const settingsChrome = (page: Page) => page.getByTestId("pane-shell-chrome");

  async function currentMaskedFingerprint(page: Page, provider: string): Promise<string> {
    const response = await page.request.get("/api/keys");
    expect(response.ok(), await response.text()).toBeTruthy();
    const payload = (await response.json()) as { data: ApiKey[] };
    const key = payload.data.find((candidate) => candidate.provider === provider);
    expect(key, `Expected ${provider} key metadata in /api/keys`).toBeTruthy();
    const fingerprint = key?.key_fingerprint ?? key?.fingerprint;
    expect(fingerprint, `Expected ${provider} key fingerprint`).toEqual(
      expect.stringMatching(/^\S{4}$/),
    );
    return `...${fingerprint}`;
  }

  test("provider cards visible", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(settingsChrome(page).getByRole("heading", { name: "API Keys" })).toBeVisible();
    await expect(page.locator("[data-provider-card='openai']")).toBeVisible();
    await expect(page.locator("[data-provider-card='anthropic']")).toBeVisible();
    await expect(page.locator("[data-provider-card='gemini']")).toBeVisible();
    await expect(page.locator("[data-provider-card='deepseek']")).toBeVisible();
  });

  test("shows safe key metadata", async ({ page }) => {
    const openaiFingerprint = await currentMaskedFingerprint(page, "openai");
    await page.goto("/settings/keys");
    await expect(settingsChrome(page).getByRole("heading", { name: "API Keys" })).toBeVisible();
    const openaiCard = page.locator("[data-provider-card='openai']");
    await expect(openaiCard.getByText(openaiFingerprint, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Last tested").first()).toBeVisible();
    await expect(page.getByText("Last used").first()).toBeVisible();
  });

  test("provider actions visible", async ({ page }) => {
    const openaiFingerprint = await currentMaskedFingerprint(page, "openai");
    await page.goto("/settings/keys");
    const openaiCard = page.locator("[data-provider-card='openai']");
    await expect(openaiCard.getByText(openaiFingerprint, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(openaiCard.getByRole("button", { name: /test/i })).toBeVisible();
    await expect(openaiCard.getByRole("button", { name: /replace/i })).toBeVisible();
    await expect(openaiCard.getByRole("button", { name: /revoke/i })).toBeVisible();

    const anthropicCard = page.locator("[data-provider-card='anthropic']");
    await expect(anthropicCard.getByRole("button", { name: /connect/i })).toBeVisible();
  });
});
