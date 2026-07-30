import { expect, test, type Page } from "@playwright/test";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const runtime = window as unknown as { __browseCspViolations?: string[] };
    runtime.__browseCspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      runtime.__browseCspViolations?.push(
        `${event.effectiveDirective || event.violatedDirective} blocked ${event.blockedURI}`,
      );
    });
  });
}

async function expectNoCspViolations(page: Page): Promise<void> {
  const violations = await page.evaluate(
    () =>
      (window as unknown as { __browseCspViolations?: string[] })
        .__browseCspViolations ?? [],
  );
  expect(
    violations,
    `unexpected Browse Preview CSP violations:\n${violations.join("\n")}`,
  ).toEqual([]);
}

test.describe("Browse Preview enforced CSP", () => {
  test("loads the allowlisted YouTube frame only after explicit activation", async ({
    page,
  }, testInfo) => {
    await recordCspViolations(page);
    const documentResponse = page.waitForResponse(
      (response) =>
        response.request().resourceType() === "document" &&
        new URL(response.url()).pathname === "/browse",
    );
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-csp-browse-video"),
      "/browse?kind=Video&source=YouTube",
    );
    const response = await documentResponse;
    expect(response).not.toBeNull();
    const csp = await response.headerValue("content-security-policy");
    expect(csp).toContain(
      "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    );
    expect(csp).toContain("media-src 'self' https:");

    const pane = activeWorkspacePane(page);
    await pane.getByRole("searchbox", { name: "Search" }).fill("Picturing Earth");
    await pane.getByRole("button", { name: "Search" }).click();
    await pane
      .getByRole("link", { name: "Picturing Earth: Behind the Scenes" })
      .click();

    await expect(
      pane.locator('iframe[title="YouTube video player"]'),
    ).toHaveCount(0);
    await pane.getByRole("button", { name: "Load video" }).click();
    await expect(
      pane.locator('iframe[title="YouTube video player"]'),
    ).toHaveAttribute(
      "src",
      "https://www.youtube.com/embed/drrP_Iss0gA",
    );
    await expectNoCspViolations(page);
  });

  test("admits HTTPS Preview audio without widening media-src", async ({
    page,
  }, testInfo) => {
    await recordCspViolations(page);
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-csp-browse-audio"),
      "/browse?kind=Podcast",
    );
    const pane = activeWorkspacePane(page);
    await pane
      .getByRole("searchbox", { name: "Search" })
      .fill("Houston We Have a Podcast");
    await pane.getByRole("button", { name: "Search" }).click();
    await pane
      .getByRole("link", { name: "Houston We Have a Podcast" })
      .click();
    await pane.getByRole("link", { name: /The Crew-4 Astronauts/ }).click();

    const audioRequest = page.waitForRequest(
      (request) =>
        request.url() ===
        "https://www.nasa.gov/wp-content/uploads/2023/07/ep239_crew-4.mp3",
    );
    await pane.getByRole("button", { name: "Play preview" }).click();
    await audioRequest;
    await expectNoCspViolations(page);
  });
});
