import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";

test.use({ journeyId: "destructive-delete" });

test("confirming conversation deletion removes the exact resource and leaves no reopenable route", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const createResponse = await api.post("/api/conversations", {
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
  const beforeDeleteResponse = await api.get("/api/conversations?limit=100");
  const beforeDeleteText = await beforeDeleteResponse.text();
  expect(
    beforeDeleteResponse.ok(),
    `Conversation index setup failed: ${beforeDeleteResponse.status()} ${beforeDeleteText.slice(0, 500)}`,
  ).toBeTruthy();
  const beforeDelete = JSON.parse(beforeDeleteText) as {
    data: {
      items: Array<{ id: string }>;
      collectionRevision: number;
    };
  };
  expect(
    beforeDelete.data.items.some(({ id }) => id === conversationId),
    `Conversation ${conversationId} was absent from its owning collection before deletion.`,
  ).toBeTruthy();

  await gotoWithStrictCsp(page, `/conversations/${conversationId}`);
  await expect(
    page.getByRole("textbox", { name: /ask anything/i }),
    `Conversation ${conversationId} was not open before destructive confirmation.`,
  ).toBeVisible();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      matchesResponse(
        response,
        webOrigin,
        "DELETE",
        `/api/conversations/${conversationId}`,
      ),
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
  const deleteText = await deleteResponse.text();
  expect(
    deleteResponse.status(),
    `Destructive boundary returned the wrong status for conversation ${conversationId}: ${deleteText.slice(0, 500)}`,
  ).toBe(200);
  const deleteResult = JSON.parse(deleteText) as {
    data: { collectionRevision: number };
  };
  expect(
    Number.isSafeInteger(deleteResult.data.collectionRevision),
    `Deletion of conversation ${conversationId} omitted a valid collection revision.`,
  ).toBeTruthy();
  expect(deleteResult.data.collectionRevision).toBeGreaterThan(
    beforeDelete.data.collectionRevision,
  );
  await expect(page).toHaveURL(/\/conversations$/);

  const deletedResponse = await api.get(
    `/api/conversations/${conversationId}`,
  );
  expect(
    deletedResponse.status(),
    `Deleted conversation ${conversationId} remained readable through its product API.`,
  ).toBe(404);
  const afterDeleteResponse = await api.get("/api/conversations?limit=100");
  const afterDeleteText = await afterDeleteResponse.text();
  expect(
    afterDeleteResponse.ok(),
    `Conversation index reload failed after deletion: ${afterDeleteResponse.status()} ${afterDeleteText.slice(0, 500)}`,
  ).toBeTruthy();
  const afterDelete = JSON.parse(afterDeleteText) as {
    data: {
      items: Array<{ id: string }>;
      collectionRevision: number;
    };
  };
  expect(afterDelete.data.collectionRevision).toBe(
    deleteResult.data.collectionRevision,
  );
  expect(
    afterDelete.data.items.some(({ id }) => id === conversationId),
    `Deleted conversation ${conversationId} remained in its owning collection.`,
  ).toBeFalsy();
  await gotoWithStrictCsp(page, `/conversations/${conversationId}`);
  await expect(
    page.getByRole("textbox", { name: /ask anything/i }),
    `Deleted conversation ${conversationId} reopened as an editable chat.`,
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /failed to load conversation/i }),
    `Deleted conversation ${conversationId} did not render the masked load failure.`,
  ).toBeVisible();
});
