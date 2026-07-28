import { expect, test, type APIRequestContext, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

interface LecternItem {
  itemId: string;
  mediaId: string;
  title: string;
  consumption: { state: "Unread" | "InProgress" | "Finished" };
}

type ReaderCursorSnapshot =
  | { state: "Empty"; revision: number }
  | {
      state: "Positioned";
      revision: number;
      locator: {
        kind: string;
        locations?: {
          progression: number | null;
          total_progression: number | null;
        };
      };
    };

const SEED_DIR = path.join(__dirname, "..", ".seed");
const NEXT_TITLE = "E2E linked-items web article seed";

function seedValue(file: string, field: string): string {
  const parsed = JSON.parse(
    readFileSync(path.join(SEED_DIR, file), "utf-8"),
  ) as Record<string, unknown>;
  const value = parsed[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${file} is missing string field ${field}`);
  }
  return value;
}

async function expectOk(
  response: {
    ok(): boolean;
    status(): number;
    statusText(): string;
    text(): Promise<string>;
  },
  label: string,
): Promise<void> {
  if (response.ok()) return;
  throw new Error(
    `${label} failed: ${response.status()} ${response.statusText()} ${await response.text()}`,
  );
}

async function lecternItems(request: APIRequestContext): Promise<LecternItem[]> {
  const response = await request.get("/api/lectern");
  await expectOk(response, "GET /api/lectern");
  return ((await response.json()) as { data: { items: LecternItem[] } }).data
    .items;
}

async function clearLectern(request: APIRequestContext): Promise<void> {
  for (const item of await lecternItems(request)) {
    const response = await request.post("/api/lectern/commands", {
      headers: stateChangingApiHeaders(),
      data: {
        kind: "RemoveItem",
        clientMutationId: randomUUID(),
        itemId: item.itemId,
      },
    });
    await expectOk(response, `RemoveItem(${item.itemId})`);
  }
}

async function resetProgress(
  request: APIRequestContext,
  mediaId: string,
): Promise<void> {
  const response = await request.post("/api/consumption/commands", {
    headers: stateChangingApiHeaders(),
    data: { kind: "ResetProgress", clientMutationId: randomUUID(), mediaId },
  });
  await expectOk(response, `ResetProgress(${mediaId})`);
}

async function placeItems(
  request: APIRequestContext,
  mediaIds: string[],
): Promise<void> {
  const response = await request.post("/api/lectern/commands", {
    headers: stateChangingApiHeaders(),
    data: {
      kind: "PlaceItems",
      clientMutationId: randomUUID(),
      mediaIds,
      placement: { kind: "Last" },
    },
  });
  await expectOk(response, `PlaceItems(${mediaIds.join(",")})`);
}

async function readerCursor(
  request: APIRequestContext,
  mediaId: string,
): Promise<ReaderCursorSnapshot> {
  const response = await request.get(`/api/media/${mediaId}/reader-state`);
  await expectOk(response, `GET reader-state(${mediaId})`);
  return ((await response.json()) as { data: ReaderCursorSnapshot }).data;
}

function deviceId(testInfo: TestInfo): string {
  return workspaceE2eDeviceId(testInfo, "e2e-reader-natural-completion");
}

test.describe("reader natural completion", () => {
  test.describe.configure({ mode: "serial" });

  let articleId: string;
  let nextId: string;

  test.beforeAll(() => {
    articleId = seedValue("reader-resume-media.json", "web_media_id");
    nextId = seedValue("non-pdf-media.json", "media_id");
  });

  test.beforeEach(async ({ request }) => {
    await clearLectern(request);
    await resetProgress(request, articleId);
    await resetProgress(request, nextId);
    await placeItems(request, [articleId, nextId]);
  });

  test.afterEach(async ({ request }) => {
    try {
      await clearLectern(request);
      await resetProgress(request, articleId);
      await resetProgress(request, nextId);
    } catch (error) {
      console.warn(
        `[reader-natural-completion] cleanup skipped: ${String(error)}`,
      );
    }
  });

  test("trusted End at the physical article bottom persists exact completion and publishes the in-flow next prompt", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      deviceId(testInfo),
      `/media/${articleId}`,
    );
    const pane = activeWorkspacePane(page);
    await expect(pane.getByText("reader resume paragraph 001")).toBeVisible({
      timeout: 15_000,
    });

    const readingArea = pane.getByRole("region", {
      name: "Document reading area",
    });
    await expect(readingArea).toBeVisible();

    expect(
      (await lecternItems(page.request)).find(
        (item) => item.mediaId === articleId,
      )?.consumption.state,
    ).toBe("Unread");
    expect((await readerCursor(page.request, articleId)).state).toBe("Empty");

    await readingArea.focus();
    await page.keyboard.press("End");

    await expect
      .poll(
        () =>
          readingArea.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(2);

    await expect
      .poll(async () => {
        const snapshot = await readerCursor(page.request, articleId);
        if (snapshot.state !== "Positioned") return null;
        return {
          kind: snapshot.locator.kind,
          progression: snapshot.locator.locations?.progression,
          totalProgression:
            snapshot.locator.locations?.total_progression,
        };
      })
      .toEqual({ kind: "web", progression: 1, totalProgression: 1 });

    await expect
      .poll(async () => {
        const item = (await lecternItems(page.request)).find(
          (candidate) => candidate.mediaId === articleId,
        );
        return item?.consumption.state ?? null;
      })
      .toBe("Finished");

    const endLabel = readingArea.getByText("End of article", { exact: true });
    await expect(endLabel).toBeInViewport();
    await expect(
      pane.getByRole("button", {
        name: new RegExp(`Next on the lectern: ${NEXT_TITLE}`),
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/media/${articleId}`));
  });
});
