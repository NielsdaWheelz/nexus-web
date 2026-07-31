import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";

test.use({ journeyId: "destructive-delete" });

test("confirming conversation deletion removes the exact resource and leaves no reopenable route", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const createResponse = await page.request.post("/api/conversations", {
    headers: { origin: webOrigin },
  });
  const createText = await createResponse.text();
  expect(
    createResponse.ok(),
    `Conversation setup failed: ${createResponse.status()} ${createText.slice(0, 500)}`,
  ).toBeTruthy();
  const conversationId = (
    JSON.parse(createText) as { data: { id: string } }
  ).data.id;

  await gotoWithStrictCsp(page, `/conversations/${conversationId}`);
  await expect(
    page.getByRole("textbox", { name: /ask anything/i }),
    `Conversation ${conversationId} was not open before destructive confirmation.`,
  ).toBeVisible();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname ===
        `/api/conversations/${conversationId}`,
  );
  page.once("dialog", async (dialog) => {
    expect(
      dialog.message(),
      `Conversation ${conversationId} did not require irreversible-action confirmation.`,
    ).toBe("Delete this conversation? This cannot be undone.");
    await dialog.accept();
  });
  await page
    .getByRole("menuitem", { name: "Delete conversation", exact: true })
    .click();
  const deleteResponse = await deleteResponsePromise;
  expect(
    deleteResponse.status(),
    `Destructive boundary returned the wrong status for conversation ${conversationId}.`,
  ).toBe(204);
  await expect(page).toHaveURL(/\/conversations$/);

  const deletedResponse = await page.request.get(
    `/api/conversations/${conversationId}`,
  );
  expect(
    deletedResponse.status(),
    `Deleted conversation ${conversationId} remained readable through its product API.`,
  ).toBe(404);
  await gotoWithStrictCsp(page, `/conversations/${conversationId}`);
  await expect(
    page.getByRole("textbox", { name: /ask anything/i }),
    `Deleted conversation ${conversationId} reopened as an editable chat.`,
  ).toHaveCount(0);
  await expect(page.getByText(/not found|could not be loaded/i)).toBeVisible();
});
