import { randomUUID } from "node:crypto";
import type { Page, Request, Response } from "playwright/test";

import { captureCanonicalArticle } from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";

test.use({ journeyId: "library-placement" });

const NAMED_LIBRARY = "Research vault";
const CREATED_WHILE_UNSUBSCRIBED = "Unsubscribed destination";

function responseSummary(response: Response): string {
  return `${new URL(response.url()).pathname} -> ${response.status()}`;
}

async function requireSuccess(response: Response, context: string): Promise<void> {
  const text = await response.text();
  expect(
    response.ok(),
    `${context} failed: ${responseSummary(response)} ${text.slice(0, 500)}`,
  ).toBeTruthy();
}

async function openPlacement(page: Page) {
  const options = page.getByRole("button", { name: "Options", exact: true });
  await expect(options).toBeVisible({ timeout: 20_000 });
  await expect(options).not.toHaveAttribute("aria-disabled", "true", {
    timeout: 20_000,
  });
  await options.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitem", { name: "Libraries…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Libraries", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listbox", { name: "Library options" })).not
    .toHaveAttribute("aria-busy", "true");
  return dialog;
}

function observeMediaReconciliation(page: Page, mediaId: string) {
  const ordering: string[] = [];
  const recordRequest = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      path === `/api/media/${mediaId}/libraries`
    ) {
      ordering.push("placement-read-started");
    }
  };
  const recordResponse = (response: Response) => {
    if (
      matchesResponse(
        response,
        webOrigin,
        "POST",
        `/api/media/${mediaId}/libraries`,
      )
    ) {
      ordering.push("command-committed");
    }
    if (
      matchesResponse(
        response,
        webOrigin,
        "POST",
        "/api/resource-items/action-snapshots/resolve",
      )
    ) {
      ordering.push("action-snapshot-reconciled");
    }
  };
  page.on("request", recordRequest);
  page.on("response", recordResponse);
  return {
    ordering,
    stop() {
      page.off("request", recordRequest);
      page.off("response", recordResponse);
    },
  };
}

function observePodcastSubscriptionCommands(page: Page) {
  let count = 0;
  const listener = (request: Request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/podcasts/subscriptions"
    ) {
      count += 1;
    }
  };
  page.on("request", listener);
  return {
    count: () => count,
    stop: () => page.off("request", listener),
  };
}

function observePodcastPlacementCommand(
  page: Page,
  libraryId: string,
  podcastId: string,
) {
  let idempotencyKey: string | null = null;
  const listener = (request: Request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname ===
        `/api/libraries/${libraryId}/podcasts/${podcastId}`
    ) {
      idempotencyKey = request.headers()["idempotency-key"] ?? null;
    }
  };
  page.on("request", listener);
  return {
    idempotencyKey: () => idempotencyKey,
    stop: () => page.off("request", listener),
  };
}

test("canonical placement supports Saved and named Media destinations, awaits reconciliation, and cannot bypass Podcast subscription", async ({
  page,
  journeyUser,
}) => {
  await page.setViewportSize({ width: 1_280, height: 900 });
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);

  const namedLibraryId = randomUUID();
  const createNamed = await api.post("/api/libraries", {
    headers: { origin: webOrigin },
    data: { library_id: namedLibraryId, name: NAMED_LIBRARY },
  });
  const createNamedText = await createNamed.text();
  expect(
    createNamed.ok(),
    `Named Library seed failed: ${createNamed.status()} ${createNamedText.slice(0, 500)}`,
  ).toBeTruthy();

  const mediaId = await captureCanonicalArticle(page, "library-placement");
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${mediaId}`);
        if (!response.ok()) return `http-${response.status()}`;
        const data = (await response.json()) as {
          data: { processing_status: string; retrieval_status: string | null };
        };
        return `${data.data.processing_status}:${data.data.retrieval_status}`;
      },
      {
        message: `Media ${mediaId} never became ready for placement.`,
        timeout: 30_000,
      },
    )
    .toBe("ready_for_reading:ready");

  const initialPlacementResponse = await api.get(
    `/api/media/${mediaId}/libraries`,
  );
  expect(initialPlacementResponse.ok()).toBeTruthy();
  const initialPlacements = (await initialPlacementResponse.json()) as {
    data: Array<{
      destination:
        | { kind: "SavedInNexus" }
        | { kind: "Library"; library: { id: string; name: string } };
      relation: { kind: string };
      availability: { kind: string; reason?: string };
    }>;
  };
  expect(
    initialPlacements.data.find(
      ({ destination }) => destination.kind === "SavedInNexus",
    ),
  ).toMatchObject({
    destination: { kind: "SavedInNexus" },
    relation: { kind: "Direct" },
    availability: { kind: "Available" },
  });
  expect(
    initialPlacements.data.find(
      ({ destination }) =>
        destination.kind === "Library" &&
        destination.library.id === namedLibraryId,
    ),
  ).toMatchObject({
    relation: { kind: "Absent" },
    availability: { kind: "Available" },
  });

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const mediaPlacement = await openPlacement(page);
  const saved = mediaPlacement.getByRole("option", {
    name: "Saved in Nexus",
    exact: true,
  });
  const named = mediaPlacement.getByRole("option", {
    name: NAMED_LIBRARY,
    exact: true,
  });
  await expect(saved).toHaveAttribute("aria-selected", "true");
  await expect(named).toHaveAttribute("aria-selected", "false");

  const reconciliation = observeMediaReconciliation(page, mediaId);
  await named.click();
  await expect(named).toHaveAttribute("aria-selected", "true");
  await expect(mediaPlacement.getByRole("listbox")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  reconciliation.stop();

  expect(
    reconciliation.ordering,
    "Chooser became Ready without command -> typed snapshot reconcile -> authoritative placement read ordering.",
  ).toEqual([
    "command-committed",
    "action-snapshot-reconciled",
    "placement-read-started",
  ]);

  const savedRemoval = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "DELETE",
      `/api/media/${mediaId}/saved-in-nexus`,
    ),
  );
  await saved.click();
  const savedRemovalResponse = await savedRemoval;
  await requireSuccess(savedRemovalResponse, "SavedInNexus removal");
  await expect(saved).toHaveAttribute("aria-selected", "false");
  await expect(mediaPlacement.getByRole("listbox")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );

  const authoritativeMediaPlacements = await api.get(
    `/api/media/${mediaId}/libraries`,
  );
  expect(authoritativeMediaPlacements.ok()).toBeTruthy();
  const mediaPlacementsAfter = (await authoritativeMediaPlacements.json()) as {
    data: Array<{
      destination: { kind: string; library?: { id: string } };
      relation: { kind: string };
    }>;
  };
  expect(
    mediaPlacementsAfter.data.find(
      ({ destination }) => destination.kind === "SavedInNexus",
    )?.relation.kind,
  ).toBe("Absent");
  expect(
    mediaPlacementsAfter.data.find(
      ({ destination }) => destination.library?.id === namedLibraryId,
    )?.relation.kind,
  ).toBe("Direct");

  const savedAddition = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "PUT",
      `/api/media/${mediaId}/saved-in-nexus`,
    ),
  );
  await saved.click();
  await requireSuccess(await savedAddition, "SavedInNexus addition");
  await expect(saved).toHaveAttribute("aria-selected", "true");
  await expect(mediaPlacement.getByRole("listbox")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );

  const namedRemoval = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "DELETE",
      `/api/media/${mediaId}/libraries/${namedLibraryId}`,
    ),
  );
  await named.click();
  await requireSuccess(await namedRemoval, "Named Library removal");
  await expect(named).toHaveAttribute("aria-selected", "false");
  await expect(mediaPlacement.getByRole("listbox")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );

  const placementsAfterNamedRemoval = await api.get(
    `/api/media/${mediaId}/libraries`,
  );
  expect(placementsAfterNamedRemoval.ok()).toBeTruthy();
  const finalMediaPlacements = (await placementsAfterNamedRemoval.json()) as {
    data: Array<{
      destination: { kind: string; library?: { id: string } };
      relation: { kind: string };
    }>;
  };
  expect(
    finalMediaPlacements.data.find(
      ({ destination }) => destination.kind === "SavedInNexus",
    )?.relation.kind,
  ).toBe("Direct");
  expect(
    finalMediaPlacements.data.find(
      ({ destination }) => destination.library?.id === namedLibraryId,
    )?.relation.kind,
  ).toBe("Absent");

  await page.keyboard.press("Escape");
  await expect(mediaPlacement).toBeHidden();

  await gotoWithStrictCsp(
    page,
    "/browse?kind=Podcast&q=Houston+We+Have+a+Podcast",
  );
  await page
    .getByRole("link", {
      name: "Houston We Have a Podcast",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/browse\/preview\?target=/);
  const subscribed = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "POST",
      "/api/podcasts/subscriptions",
    ),
  );
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await requireSuccess(await subscribed, "Podcast subscription seed");
  await expect(page).toHaveURL(/\/podcasts\/[0-9a-f-]{36}$/i);
  const podcastId = new URL(page.url()).pathname.split("/").at(-1);
  expect(podcastId).toMatch(/^[0-9a-f-]{36}$/i);

  const subscriptionCommands = observePodcastSubscriptionCommands(page);
  const subscribedPlacement = await openPlacement(page);
  const subscribedNamed = subscribedPlacement.getByRole("option", {
    name: NAMED_LIBRARY,
    exact: true,
  });
  await expect(subscribedNamed).toHaveAttribute("aria-selected", "false");
  await expect(subscribedNamed).not.toHaveAttribute("aria-disabled", "true");
  const podcastPlacementCommand = observePodcastPlacementCommand(
    page,
    namedLibraryId,
    podcastId ?? "",
  );
  const podcastNamedAddition = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "PUT",
      `/api/libraries/${namedLibraryId}/podcasts/${podcastId}`,
    ),
  );
  await subscribedNamed.click();
  const podcastNamedAdditionResponse = await podcastNamedAddition;
  await requireSuccess(
    podcastNamedAdditionResponse,
    "Subscribed Podcast named-Library placement",
  );
  podcastPlacementCommand.stop();
  expect(podcastPlacementCommand.idempotencyKey()).toMatch(
    /^[0-9a-f-]{36}$/i,
  );
  await expect(subscribedNamed).toHaveAttribute("aria-selected", "true");
  await expect(subscribedPlacement.getByRole("listbox")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(
    subscriptionCommands.count(),
    "Podcast placement created a subscription instead of using the placement owner.",
  ).toBe(0);
  await page.keyboard.press("Escape");
  await expect(subscribedPlacement).toBeHidden();

  const subscribedPlacementsResponse = await api.get(
    `/api/podcasts/${podcastId}/libraries`,
  );
  expect(subscribedPlacementsResponse.ok()).toBeTruthy();
  const subscribedPlacements = (await subscribedPlacementsResponse.json()) as {
    data: Array<{
      destination: { kind: string; library?: { id: string } };
      relation: { kind: string };
    }>;
  };
  expect(
    subscribedPlacements.data.find(
      ({ destination }) => destination.library?.id === namedLibraryId,
    )?.relation.kind,
  ).toBe("Direct");

  const unsubscribe = await api.delete(
    `/api/podcasts/subscriptions/${podcastId}`,
    {
      headers: {
        origin: webOrigin,
        "Idempotency-Key": randomUUID(),
      },
    },
  );
  const unsubscribeText = await unsubscribe.text();
  expect(
    unsubscribe.ok(),
    `Podcast unsubscribe seed failed: ${unsubscribe.status()} ${unsubscribeText.slice(0, 500)}`,
  ).toBeTruthy();

  await gotoWithStrictCsp(page, `/podcasts/${podcastId}`);
  const podcastPlacement = await openPlacement(page);
  await expect(
    podcastPlacement.getByRole("option", { name: new RegExp(NAMED_LIBRARY) }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    podcastPlacement.getByRole("option", { name: new RegExp(NAMED_LIBRARY) }),
  ).toHaveAttribute("aria-selected", "false");
  await expect(
    podcastPlacement.getByText(
      "Subscribe to this podcast before adding it to a library.",
    ),
  ).toBeAttached();
  await expect(
    podcastPlacement.getByRole("option", { name: "Saved in Nexus" }),
  ).toHaveCount(0);

  const podcastSearch = podcastPlacement.getByRole("combobox", {
    name: "Search or create a library",
  });
  await podcastSearch.fill(CREATED_WHILE_UNSUBSCRIBED);
  const createdLibraryResponse = page.waitForResponse(
    (response) =>
      matchesResponse(response, webOrigin, "POST", "/api/libraries"),
  );
  await podcastPlacement
    .getByRole("option", {
      name: `Create “${CREATED_WHILE_UNSUBSCRIBED}”`,
      exact: true,
    })
    .click();
  const createdLibrary = await createdLibraryResponse;
  await requireSuccess(createdLibrary, "Create Library from Podcast placement");
  const createdBlocked = podcastPlacement.getByRole("option", {
    name: new RegExp(CREATED_WHILE_UNSUBSCRIBED),
  });
  await expect(createdBlocked).toHaveAttribute("aria-disabled", "true");
  subscriptionCommands.stop();
  expect(
    subscriptionCommands.count(),
    "Create Library bypassed RequiresSubscription by implicitly subscribing.",
  ).toBe(0);

  const podcastPlacementsResponse = await api.get(
    `/api/podcasts/${podcastId}/libraries`,
  );
  expect(podcastPlacementsResponse.ok()).toBeTruthy();
  const podcastPlacements = (await podcastPlacementsResponse.json()) as {
    data: Array<{
      destination: { kind: string; library?: { name: string } };
      relation: { kind: string };
      availability: { kind: string; reason?: string };
    }>;
  };
  expect(
    podcastPlacements.data.find(
      ({ destination }) =>
        destination.library?.name === CREATED_WHILE_UNSUBSCRIBED,
    ),
  ).toMatchObject({
    relation: { kind: "Absent" },
    availability: { kind: "Blocked", reason: "RequiresSubscription" },
  });
  expect(
    podcastPlacements.data.some(
      ({ destination }) => destination.kind === "SavedInNexus",
    ),
  ).toBe(false);
});
