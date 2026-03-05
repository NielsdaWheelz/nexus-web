import { test, expect } from "@playwright/test";

async function createLibraryViaUi(
  page: Parameters<typeof test>[0]["page"],
  prefix: string
): Promise<{ id: string; name: string; role: string }> {
  const nameInput = page.getByPlaceholder("New library name...");
  await expect(nameInput).toBeVisible();
  const libraryName = `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  await nameInput.fill(libraryName);
  const createResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/libraries" &&
      response.request().method() === "POST" &&
      response.status() === 201
  );
  await page.getByRole("button", { name: /^create$/i }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBeTruthy();
  const payload = (await createResponse.json()) as {
    data: { id: string; name: string; role: string };
  };

  return { id: payload.data.id, name: payload.data.name, role: payload.data.role };
}

test.describe("libraries", () => {
  test("create library", async ({ page }) => {
    await page.goto("/libraries");
    let createdId: string | null = null;
    try {
      const created = await createLibraryViaUi(page, "Test Library");
      createdId = created.id;
      expect(created.role).toBe("admin");

      const getResponse = await page.request.get(`/api/libraries/${created.id}`);
      expect(getResponse.ok()).toBeTruthy();
    } finally {
      if (createdId) {
        await page.request.delete(`/api/libraries/${createdId}`);
      }
    }
  });

  test("browse and select library", async ({ page }) => {
    await page.goto("/libraries");
    // The default library always exists — look for the default badge text.
    const defaultBadge = page.getByText(/^default$/i);
    await expect(defaultBadge).toBeVisible();
    // Click the first library link to navigate to its detail page
    const libraryLink = page.locator("a[href^='/libraries/']").first();
    await expect(libraryLink).toBeVisible();
    await libraryLink.click();
    await expect(page).toHaveURL(/libraries\/.+/);
  });

  test("membership management guardrail", async ({ page }) => {
    // Create a non-default library so the Rename UI is visible
    await page.goto("/libraries");
    let createdId: string | null = null;
    try {
      const created = await createLibraryViaUi(page, "Mgmt Test");
      createdId = created.id;

      const detailsResponse = await page.request.get(`/api/libraries/${created.id}`);
      expect(detailsResponse.ok()).toBeTruthy();
      const details = (await detailsResponse.json()) as { data: { role: string } };
      expect(details.data.role).toBe("admin");

      const renamed = `${created.name} Renamed`;
      const renameResponse = await page.request.patch(`/api/libraries/${created.id}`, {
        data: { name: renamed },
      });
      expect(renameResponse.ok()).toBeTruthy();
      const renamedPayload = (await renameResponse.json()) as { data: { name: string } };
      expect(renamedPayload.data.name).toBe(renamed);
    } finally {
      if (createdId) {
        await page.request.delete(`/api/libraries/${createdId}`);
      }
    }
  });
});
