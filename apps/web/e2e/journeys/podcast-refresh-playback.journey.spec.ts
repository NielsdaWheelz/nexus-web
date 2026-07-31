import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
} from "../fixtures";

test.use({ journeyId: "podcast-refresh-playback" });

test("a subscribed podcast refreshes through its durable run and opens an episode in the player", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  await gotoWithStrictCsp(
    page,
    "/browse?kind=Podcast&q=Houston+We+Have+a+Podcast",
  );
  const show = page.getByRole("link", {
    name: "Houston We Have a Podcast",
    exact: true,
  });
  await expect(
    show,
    "Deterministic Podcast discovery did not expose Houston We Have a Podcast.",
  ).toBeVisible();
  await show.click();
  await expect(page).toHaveURL(/\/browse\/preview\?target=/);

  const subscribeResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/podcasts/subscriptions",
  );
  await page
    .getByRole("button", { name: "Subscribe", exact: true })
    .click();
  const subscribeResponse = await subscribeResponsePromise;
  const subscribeText = await subscribeResponse.text();
  expect(
    subscribeResponse.ok(),
    `Podcast subscription failed: ${subscribeResponse.status()} ${subscribeText.slice(0, 500)}`,
  ).toBeTruthy();
  await expect(page).toHaveURL(/\/podcasts\/[0-9a-f-]{36}$/i);
  const podcastId = new URL(page.url()).pathname.split("/").at(-1);
  expect(podcastId, "Subscribed Podcast route omitted its canonical id.").toMatch(
    /^[0-9a-f-]{36}$/i,
  );
  const episode = page.getByRole("link", {
    name: "The Crew-4 Astronauts",
    exact: true,
  });
  await expect(
    episode,
    `Podcast ${podcastId} did not publish its fixture episode after subscription sync.`,
  ).toBeVisible({ timeout: 25_000 });

  await page.getByRole("button", { name: "Options", exact: true }).click();
  const refreshAdmissionPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/podcasts/refresh-runs",
  );
  await page.getByRole("menuitem", { name: "Refresh", exact: true }).click();
  const refreshAdmission = await refreshAdmissionPromise;
  const refreshText = await refreshAdmission.text();
  expect(
    refreshAdmission.ok(),
    `Refresh admission for podcast ${podcastId} failed: ${refreshAdmission.status()} ${refreshText.slice(0, 500)}`,
  ).toBeTruthy();
  const refreshHandle = (
    JSON.parse(refreshText) as { data: { refreshRunHandle: string } }
  ).data.refreshRunHandle;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/podcasts/refresh-runs/${encodeURIComponent(refreshHandle)}`,
        );
        if (!response.ok()) return `http-${response.status()}`;
        return ((await response.json()) as { data: { status: string } }).data
          .status;
      },
      {
        message: `Expected refresh ${refreshHandle} for podcast ${podcastId} to complete.`,
        timeout: 20_000,
      },
    )
    .toBe("Complete");

  await episode.click();
  await expect(page).toHaveURL(/\/media\/[0-9a-f-]{36}$/i);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const player = page.getByRole("region", { name: "Media player" });
  await expect(
    player,
    `Episode from podcast ${podcastId} did not establish a global player session after refresh ${refreshHandle}.`,
  ).toBeVisible();
  await expect(player).toContainText("The Crew-4 Astronauts");
  const controls = player.getByRole("group", { name: "Media player controls" });
  await expect(controls).toBeVisible();
  await expect(
    controls.getByRole("button", { name: /^(?:Play|Pause) media player$/ }),
    `Episode from podcast ${podcastId} did not establish an operable player session.`,
  ).toBeVisible();
});
