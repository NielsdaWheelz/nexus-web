import { expect, type Locator, type Page } from "@playwright/test";

const GITHUB_USERNAME = process.env.E2E_GITHUB_USERNAME;
const GITHUB_PASSWORD = process.env.E2E_GITHUB_PASSWORD;
const GITHUB_OTP_CODE = process.env.E2E_GITHUB_OTP_CODE;

async function isVisible(locator: Locator, timeoutMs = 2_000): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export function canRunGitHubProviderRoundTrip(): boolean {
  return Boolean(GITHUB_USERNAME && GITHUB_PASSWORD);
}

export function gitHubProviderRoundTripSkipReason(): string {
  return "Set E2E_GITHUB_USERNAME and E2E_GITHUB_PASSWORD to run real provider round-trip coverage.";
}

async function submitGitHubLoginForm(page: Page) {
  const loginInput = page.locator("input[name='login']");
  if (!(await isVisible(loginInput, 12_000))) {
    const currentUrl = page.url();
    if (currentUrl.includes("github.com/login")) {
      throw new Error(
        "GitHub login form was not detected on github.com/login. Update provider-roundtrip selectors."
      );
    }
    return;
  }

  if (!GITHUB_USERNAME || !GITHUB_PASSWORD) {
    throw new Error(gitHubProviderRoundTripSkipReason());
  }

  await loginInput.fill(GITHUB_USERNAME);
  await page.locator("input[name='password']").fill(GITHUB_PASSWORD);
  await page.locator("input[name='commit']").click();
}

async function submitGitHubOtpIfNeeded(page: Page) {
  const otpInput = page.locator("input[name='app_otp']");
  if (!(await isVisible(otpInput, 5_000))) {
    return;
  }

  if (!GITHUB_OTP_CODE) {
    throw new Error(
      "GitHub prompted for one-time passcode. Set E2E_GITHUB_OTP_CODE for this run."
    );
  }

  await otpInput.fill(GITHUB_OTP_CODE);
  await page.locator("button[type='submit']").first().click();
}

async function approveGitHubOAuthAppIfPrompted(page: Page) {
  const authorizeButton = page
    .locator(
      "button[name='authorize'], input[name='authorize'], button:has-text('Authorize')"
    )
    .first();

  if (await isVisible(authorizeButton, 8_000)) {
    await authorizeButton.click();
  }
}

export async function runGitHubProviderRoundTrip(page: Page) {
  await page.getByRole("button", { name: /continue with github/i }).click();
  await page.waitForURL(/github\.com|\/auth\/callback|\/libraries/, {
    timeout: 120_000,
  });

  await submitGitHubLoginForm(page);
  await submitGitHubOtpIfNeeded(page);
  await approveGitHubOAuthAppIfPrompted(page);

  await page.waitForURL(/\/auth\/callback|\/libraries/, { timeout: 120_000 });
  if (page.url().includes("/auth/callback")) {
    await page.waitForURL(/\/libraries/, { timeout: 120_000 });
  }

  await expect(page).toHaveURL(/\/libraries/);
}
