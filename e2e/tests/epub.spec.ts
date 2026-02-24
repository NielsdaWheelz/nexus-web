import { test, expect } from "@playwright/test";

test.describe("epub", () => {
  test("upload EPUB", async ({ page }) => {
    await page.goto("/libraries");
    // Locate the file upload input for EPUB/PDF files
    const fileInput = page.locator("input[type='file']");
    const uploadButton = page.getByRole("button", { name: /upload file/i });
    // At least one upload mechanism should be available on the libraries page
    await expect(
      fileInput.or(uploadButton).first()
    ).toBeAttached();
  });

  test.fixme("open reader", async () => {
    // Requires seeded EPUB media. Implement when E2E data seeding covers EPUB upload.
  });

  test.fixme("navigate chapters and TOC", async () => {
    // Requires seeded EPUB with multiple chapters.
  });

  test.fixme("create highlight in epub", async () => {
    // Requires seeded EPUB with readable content for text selection.
  });
});
