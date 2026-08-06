import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";

test.use({ journeyId: "podcast-refresh-playback" });

test("a subscribed podcast refreshes and durably resumes real episode playback", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
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
      matchesResponse(response, webOrigin, "POST", "/api/podcasts/subscriptions"),
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
  await page.getByRole("button", { name: "Options", exact: true }).click();
  const refreshAdmissionPromise = page.waitForResponse(
    (response) =>
      matchesResponse(response, webOrigin, "POST", "/api/podcasts/refresh-runs"),
  );
  await page
    .getByRole("menuitem", { name: "Check for new episodes", exact: true })
    .click();
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
        const response = await api.get(
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

  const episode = page.getByRole("link", {
    name: "The Crew-4 Astronauts",
    exact: true,
  });
  await expect(
    episode,
    `Podcast ${podcastId} did not reconcile its fixture episode after refresh ${refreshHandle}.`,
  ).toBeVisible({ timeout: 25_000 });

  // The episode pane's domain view is pane-URL state. Only a real reload proves
  // that the URL survives the workspace bootstrap and re-requests the same view
  // through the BFF; a mounted component test supplies the href itself.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const episodeSort = page.getByRole("combobox", { name: "Sort by", exact: true });
  await episodeSort.selectOption({ label: "Oldest" });
  await expect(page).toHaveURL(new RegExp(`/podcasts/${podcastId}\\?sort=oldest$`, "i"));
  await gotoWithStrictCsp(page, `/podcasts/${podcastId}?sort=oldest`);
  await expect(
    page.getByText("Invalid episodes view"),
    `Reloading podcast ${podcastId} at sort=oldest rejected its own URL.`,
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Filter(?:,|$)/ }).click();
  await expect(
    page.getByRole("combobox", { name: "Sort by", exact: true }),
    `Podcast ${podcastId} did not restore its non-default episode view across a reload.`,
  ).toHaveValue("oldest");

  await gotoWithStrictCsp(page, `/podcasts/${podcastId}`);
  await expect(episode).toBeVisible({ timeout: 25_000 });
  await episode.click();
  await expect(page).toHaveURL(/\/media\/[0-9a-f-]{36}$/i);
  const mediaId = new URL(page.url()).pathname.split("/").at(-1);
  expect(mediaId).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(
    page.getByText(/astronauts of NASA's SpaceX Crew-4 mission/i),
    `Episode from podcast ${podcastId} lost its fixture-owned show notes after refresh ${refreshHandle}.`,
  ).toBeVisible();
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
  await controls.getByRole("button", { name: "Play media player", exact: true }).click();
  await expect(
    controls.getByRole("button", { name: "Pause media player", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  const seek = player.getByRole("slider", { name: "Seek playback position" });
  await expect(
    seek,
    `Episode ${mediaId} never loaded a run-local playable duration.`,
  ).toBeEnabled({ timeout: 15_000 });
  const durationMs = Number(await seek.getAttribute("max"));
  expect(durationMs).toBeGreaterThan(15_000);
  const targetMs = Math.min(30_000, Math.floor(durationMs / 3));
  await seek.fill(String(targetMs));
  await controls.getByRole("button", { name: "Pause media player", exact: true }).click();

  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${mediaId}/listening-state`);
        if (!response.ok()) return -response.status();
        return ((await response.json()) as { data: { positionMs: number } }).data
          .positionMs;
      },
      {
        message: `Episode ${mediaId} did not durably checkpoint the visible seek to ${targetMs}ms.`,
        timeout: 15_000,
      },
    )
    .toBeGreaterThanOrEqual(targetMs - 1_000);

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const resumedSeek = page.getByRole("region", { name: "Media player" }).getByRole(
    "slider",
    { name: "Seek playback position" },
  );
  await expect(resumedSeek).toBeEnabled({ timeout: 15_000 });
  expect(Number(await resumedSeek.inputValue())).toBeGreaterThanOrEqual(
    targetMs - 1_000,
  );
});
