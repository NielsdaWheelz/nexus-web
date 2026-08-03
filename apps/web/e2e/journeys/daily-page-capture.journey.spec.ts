import { randomUUID } from "node:crypto";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { pageRequest } from "../request";

test.use({ journeyId: "daily-page-capture" });

interface DailyDescriptor {
  kind: "Latent" | "Materialized";
  surface?: {
    ordered_items: Array<{
      target: {
        content:
          | { kind: "note_body"; body_text: string }
          | { kind: string };
      };
    }>;
  };
}

function exactCopies(descriptor: DailyDescriptor, noteText: string): number {
  return (
    descriptor.surface?.ordered_items.filter(
      ({ target }) =>
        target.content.kind === "note_body" &&
        "body_text" in target.content &&
        target.content.body_text === noteText,
    ).length ?? 0
  );
}

test("Quick Note persists exactly once through Today and a fresh document", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const noteText = `Daily Quick Note ${randomUUID()}`;
  const navigation = page.getByRole("navigation", { name: "Primary" });

  await navigation
    .getByRole("button", { name: "Search or ask anything", exact: true })
    .click();
  const nexus = page.getByRole("dialog", { name: "Nexus" });
  await nexus
    .getByRole("gridcell", { name: /^Quick Note(?:\.|$)/ })
    .click();
  await expect(page).toHaveURL(/\/daily\/\d{4}-\d{2}-\d{2}(?:[?#]|$)/);
  const localDate = /^\/daily\/(\d{4}-\d{2}-\d{2})$/.exec(
    new URL(page.url()).pathname,
  )?.[1];
  expect(localDate, "Quick Note did not expose its account-local date.").toMatch(
    /^\d{4}-\d{2}-\d{2}$/,
  );
  const editor = page.getByRole("textbox", { name: "Edit note 1" });
  await expect(editor).toBeFocused({ timeout: 15_000 });
  await page.keyboard.insertText(noteText);

  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/notes/daily/${localDate}`);
        if (!response.ok()) return -response.status();
        return exactCopies(
          ((await response.json()) as { data: DailyDescriptor }).data,
          noteText,
        );
      },
      {
        message: `Quick Note did not persist exactly one copy of ${JSON.stringify(noteText)} on ${localDate}.`,
        timeout: 20_000,
      },
    )
    .toBe(1);

  await navigation
    .getByRole("button", { name: "Search or ask anything", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Nexus" })
    .getByRole("gridcell", { name: /^Today(?:\.|$)/ })
    .click();
  await expect(page).toHaveURL(`/daily/${localDate}`);
  await expect(
    page.getByRole("textbox", { name: "Edit note 1" }),
    `Today did not reveal the Quick Note ${JSON.stringify(noteText)} on ${localDate}.`,
  ).toContainText(noteText);

  await gotoWithStrictCsp(page, `/daily/${localDate}`);
  await expect(
    page.getByRole("textbox", { name: "Edit note 1" }),
    `Fresh document lost the Quick Note ${JSON.stringify(noteText)} on ${localDate}.`,
  ).toContainText(noteText);
  const persisted = await api.get(`/api/notes/daily/${localDate}`);
  expect(persisted.ok()).toBeTruthy();
  expect(
    exactCopies(
      ((await persisted.json()) as { data: DailyDescriptor }).data,
      noteText,
    ),
  ).toBe(1);
});
