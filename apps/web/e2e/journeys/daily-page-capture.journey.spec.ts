import { randomUUID } from "node:crypto";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
} from "../fixtures";

test.use({ journeyId: "daily-page-capture" });

test("a browser share captures one durable note on today's page and opens it", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const noteText = `Daily capture ${randomUUID()}`;
  await gotoWithStrictCsp(
    page,
    `/share?text=${encodeURIComponent(noteText)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Saved to Nexus" }),
    `Browser share did not acknowledge daily capture ${JSON.stringify(noteText)}.`,
  ).toBeVisible();
  await expect(page.getByText("Added to today", { exact: true })).toBeVisible();
  const open = page.getByRole("link", { name: "Open", exact: true });
  await expect(open).toHaveAttribute("href", /^\/daily\/\d{4}-\d{2}-\d{2}$/);
  await open.click();
  await expect(page).toHaveURL(/\/daily\/\d{4}-\d{2}-\d{2}$/);
  const localDate = new URL(page.url()).pathname.split("/").at(-1);
  expect(
    localDate,
    `Daily capture ${JSON.stringify(noteText)} opened a route without a local date.`,
  ).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(
    page.getByRole("textbox", { name: "Edit note 1" }),
    `Daily page ${localDate} did not render captured note ${JSON.stringify(noteText)}.`,
  ).toContainText(noteText);

  const descriptorResponse = await page.request.get(
    `/api/notes/daily/${localDate}`,
  );
  const descriptorText = await descriptorResponse.text();
  expect(
    descriptorResponse.ok(),
    `Daily page read for ${localDate} failed: ${descriptorResponse.status()} ${descriptorText.slice(0, 500)}`,
  ).toBeTruthy();
  const descriptor = JSON.parse(descriptorText) as {
    data: {
      kind: string;
      surface?: {
        orderedItems: Array<{
          target: { content: { kind: string; bodyText?: string } };
        }>;
      };
    };
  };
  const copies =
    descriptor.data.surface?.orderedItems.filter(
      ({ target }) =>
        target.content.kind === "note_body" &&
        target.content.bodyText === noteText,
    ).length ?? 0;
  expect(
    copies,
    `Daily page ${localDate} persisted ${copies} copies of capture ${JSON.stringify(noteText)}.`,
  ).toBe(1);
});
