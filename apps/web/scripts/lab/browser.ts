// follow the real password form's continuation. callers own authenticated
// readiness, identity checks, browser lifetime and any scenario-specific reset.
import type { Page } from "@playwright/test";
import { DEFAULT_RETURN_TARGET } from "@/lib/auth/urls";

export async function login(
  page: Page,
  input: { web_origin: string; email: string; password: string },
): Promise<void> {
  const origin = new URL(input.web_origin);
  if (origin.origin !== input.web_origin || origin.hostname !== "127.0.0.1" || origin.protocol !== "http:")
    throw new Error("browser login requires an exact loopback http origin");
  await page.goto(`${input.web_origin}/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Use email and password", exact: true }).click();
  const form = page.getByRole("form", { name: "Sign in with email and password", exact: true });
  await form.getByRole("textbox", { name: "Email", exact: true }).fill(input.email);
  await form.getByLabel("Password", { exact: true }).fill(input.password);
  // the hydrated form owns its continuation; a competing navigation can abort it.
  const [response] = await Promise.all([
    page.waitForResponse((response) =>
      response.url() === `${input.web_origin}/auth/password/sign-in` &&
      response.request().method() === "POST",
    ),
    form.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  if (response.status() !== 303)
    throw new Error(`browser login refused: expected 303, received ${response.status()}`);
  await page.waitForURL(`${input.web_origin}${DEFAULT_RETURN_TARGET}`, { waitUntil: "domcontentloaded" });
}
