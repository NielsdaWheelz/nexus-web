import { expect, test } from "@playwright/test";

test.describe("oracle", () => {
  test("loads the authenticated landing pane", async ({ page }) => {
    await page.goto("/oracle");

    await expect(
      page.getByText("Black Forest Oracle", { exact: true }),
    ).toBeVisible();
    const question = page.getByRole("textbox", { name: "Oracle question" });
    await expect(question).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Consult the oracle" }),
    ).toBeDisabled();

    await question.fill("Where does the path open?");
    await expect(
      page.getByRole("button", { name: "Consult the oracle" }),
    ).toBeEnabled();
  });
});
