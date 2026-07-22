import { expect, type Locator, type Page } from "@playwright/test";

export async function openAddContentPanel(page: Page): Promise<Locator> {
  await page
    .locator("nav")
    .getByRole("button", { name: "Add content" })
    .click();
  const add = page.getByRole("dialog", { name: "Add content" });
  await expect(add).toBeVisible();
  await expect(add.getByRole("heading", { name: "Add content" })).toBeVisible();
  await expect(add.getByRole("textbox", { name: "Links" })).toBeVisible();
  return add;
}
