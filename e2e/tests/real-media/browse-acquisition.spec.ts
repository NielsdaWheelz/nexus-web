import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { stateChangingApiHeaders } from "../api";
import { bootstrapMagicLinkSessionForEmail } from "../auth-bootstrap";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "../workspace";

test("@real-media Browse previews before subscribing, then opens the canonical Podcast", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  let podcastId: string | null = null;

  try {
    await bootstrapMagicLinkSessionForEmail(
      page,
      request,
      `e2e-real-media-browse-${randomUUID()}@nexus.local`,
    );
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-real-media-browse-podcast"),
      "/browse?kind=Podcast&q=Houston+We+Have+a+Podcast",
    );
    const pane = activeWorkspacePane(page);
    const body = pane.getByTestId("pane-shell-body");

    const result = pane.getByRole("link", {
      name: "Houston We Have a Podcast",
    });
    await expect(result).toBeVisible({ timeout: 15_000 });
    await result.click();

    await expect(page).toHaveURL(/\/browse\/preview\?target=/);
    await expect(
      body.getByRole("heading", { name: "Houston We Have a Podcast" }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Subscribe", exact: true }),
    ).toBeVisible();

    const subscribeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/podcasts/subscriptions",
    );
    await pane.getByRole("button", { name: "Subscribe", exact: true }).click();
    expect((await subscribeResponse).ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/podcasts\/[0-9a-f-]+$/, {
      timeout: 30_000,
    });
    podcastId = new URL(page.url()).pathname.split("/").at(-1) ?? null;
    expect(podcastId).toBeTruthy();
    await expect(
      pane.getByRole("button", { name: "Subscribed", exact: true }),
    ).toBeVisible();
  } finally {
    if (podcastId) {
      const response = await page.request.delete(
        `/api/podcasts/subscriptions/${podcastId}`,
        {
          headers: {
            ...stateChangingApiHeaders(),
            "Idempotency-Key": randomUUID(),
          },
        },
      );
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    await context.close();
  }
});

test("@real-media Browse opens an Episode preview and adds it without subscribing", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  let mediaId: string | null = null;

  try {
    await bootstrapMagicLinkSessionForEmail(
      page,
      request,
      `e2e-real-media-episode-${randomUUID()}@nexus.local`,
    );
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-real-media-browse-episode"),
      "/browse?kind=Podcast&q=Houston+We+Have+a+Podcast",
    );
    const pane = activeWorkspacePane(page);
    const body = pane.getByTestId("pane-shell-body");
    const chrome = pane.getByTestId("pane-shell-chrome");
    await pane
      .getByRole("link", { name: "Houston We Have a Podcast" })
      .click();

    await pane
      .getByRole("link", { name: /The Crew-4 Astronauts/ })
      .click();
    await expect(page).toHaveURL(/\/browse\/preview\?target=/);
    await expect(
      body.getByRole("heading", { name: "The Crew-4 Astronauts" }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Add", exact: true }),
    ).toBeVisible();

    await pane.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page).toHaveURL(/\/media\/[0-9a-f-]+$/);
    mediaId = new URL(page.url()).pathname.split("/").at(-1) ?? null;
    expect(mediaId).toBeTruthy();
    await expect(
      chrome.getByRole("heading", { name: "The Crew-4 Astronauts" }),
    ).toBeVisible();
  } finally {
    if (mediaId) {
      const response = await page.request.delete(`/api/media/${mediaId}`, {
        headers: stateChangingApiHeaders(),
      });
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    await context.close();
  }
});
