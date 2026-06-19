import { expect, type Locator, type Page } from "@playwright/test";

type AddContentMode = "url" | "file";

const ADD_ROW_NAME: Record<AddContentMode, RegExp> = {
  url: /^Add from URL/,
  file: /^Upload file/,
};

export async function openAddContentPanel(
  page: Page,
  mode: AddContentMode,
): Promise<Locator> {
  await page.locator("nav").getByRole("button", { name: "Add content" }).click();
  const launcher = page.getByRole("dialog", { name: "Launcher" });
  await expect(launcher).toBeVisible();

  await launcher.getByRole("option", { name: ADD_ROW_NAME[mode] }).click();
  await expect(launcher.getByRole("heading", { name: "Add content" })).toBeVisible();
  return launcher;
}
