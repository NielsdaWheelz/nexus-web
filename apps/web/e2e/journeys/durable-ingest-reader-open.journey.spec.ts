import { randomUUID } from "node:crypto";
import type { APIResponse } from "playwright/test";
import { TOOL_PROJECTION_REVISION } from "@/lib/conversations/toolContractProjection";
import { captureCanonicalArticle } from "../articleFixture";
import {
  adversarialTruncatedPdf,
  boundedCitationPdf,
  uniqueCanonicalReaderEpub,
} from "../corpus";
import {
  apiOrigin,
  expect,
  gotoWithStrictCsp,
  minioOrigin,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { pageRequest, type ExactOriginRequest } from "../request";

test.use({ journeyId: "durable-ingest-reader-open" });

const TOOL_PROJECTION_HEADER = "X-Nexus-Tool-Projection";

interface UploadInit {
  data: {
    media_id: string;
    source_attempt_id: string;
    upload_url: string;
  };
}

interface ActivityItem {
  media_id: string;
  state:
    | {
        kind: "Active";
        status: "Queued" | "Processing";
        stage: "Validate" | "Extract" | "Finalize" | "Index";
        progress:
          | { kind: "Absent" }
          | {
              kind: "Present";
              value:
                | { kind: "Stage"; stage: string }
                | {
                    kind: "Counted";
                    stage: "Extract";
                    completed: number;
                    total: number;
                    unit: "Page" | "Chapter";
                  };
            };
      }
    | {
        kind: "NeedsAttention";
        scope: "Source" | "Search";
        stage: "Validate" | "Extract" | "Finalize" | "Index";
        failure_code: { kind: "Absent" } | { kind: "Present"; value: string };
      };
}

async function readBody(response: APIResponse) {
  const text = await response.text();
  expect(
    response.ok(),
    `Expected ${response.url()} to succeed; status=${response.status()} body=${text.slice(0, 500)}`,
  ).toBeTruthy();
  return JSON.parse(text) as unknown;
}

async function acceptPdfUpload(
  api: ExactOriginRequest,
  objects: ExactOriginRequest,
  payload: Buffer,
  filename: string,
  idempotencyKey: string,
): Promise<UploadInit["data"]> {
  const initResponse = await api.post("/api/media/upload/init", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": idempotencyKey,
    },
    data: {
      kind: "pdf",
      filename,
      content_type: "application/pdf",
      size_bytes: payload.byteLength,
      library_ids: [],
    },
  });
  const init = (await readBody(initResponse)) as UploadInit;
  expect(new URL(init.data.upload_url).origin).toBe(minioOrigin);
  const uploaded = await objects.put(init.data.upload_url, {
    headers: { "Content-Type": "application/pdf" },
    data: payload,
  });
  expect(
    uploaded.ok(),
    `Local object upload for PDF ${init.data.media_id} failed with ${uploaded.status()}.`,
  ).toBeTruthy();
  const confirmed = await api.post(`/api/media/${init.data.media_id}/ingest`, {
    headers: { origin: webOrigin },
    data: { library_ids: [] },
  });
  const confirmation = (await readBody(confirmed)) as {
    data: {
      media_id: string;
      source_attempt_id: string;
      duplicate: boolean;
      ingest_enqueued: boolean;
    };
  };
  expect(confirmation.data).toMatchObject({
    media_id: init.data.media_id,
    source_attempt_id: init.data.source_attempt_id,
    duplicate: false,
    ingest_enqueued: true,
  });
  return init.data;
}

async function activityItem(
  api: ExactOriginRequest,
  mediaId: string,
): Promise<ActivityItem | undefined> {
  const response = await api.get("/api/media/activity?limit=20");
  const payload = (await readBody(response)) as {
    data: { items: ActivityItem[] };
  };
  return payload.data.items.find((item) => item.media_id === mediaId);
}

test("an accepted EPUB publishes in the default Library and opens through its real row", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const objects = pageRequest(page, minioOrigin);
  const profileResponse = await api.get("/api/me");
  const profileText = await profileResponse.text();
  expect(
    profileResponse.ok(),
    `Default Library lookup for ${journeyUser.id} failed: ${profileResponse.status()} ${profileText.slice(0, 500)}`,
  ).toBeTruthy();
  const defaultLibraryId = (
    JSON.parse(profileText) as { data: { default_library_id: string } }
  ).data.default_library_id;
  const epub = uniqueCanonicalReaderEpub(journeyUser.id);
  const initResponse = await api.post("/api/media/upload/init", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": `durable-ingest-${journeyUser.id}`,
    },
    data: {
      kind: "epub",
      filename: "canonical-reader-durable-ingest.epub",
      content_type: "application/epub+zip",
      size_bytes: epub.byteLength,
      library_ids: [],
    },
  });
  const init = (await readBody(initResponse)) as UploadInit;
  expect(new URL(init.data.upload_url).origin).toBe(minioOrigin);

  const objectResponse = await objects.put(init.data.upload_url, {
    headers: { "Content-Type": "application/epub+zip" },
    data: epub,
  });
  expect(
    objectResponse.ok(),
    `Local object upload for media ${init.data.media_id} failed with ${objectResponse.status()}.`,
  ).toBeTruthy();

  const confirmResponse = await api.post(
    `/api/media/${init.data.media_id}/ingest`,
    {
      headers: { origin: webOrigin },
      data: { library_ids: [] },
    },
  );
  const confirmed = (await readBody(confirmResponse)) as {
    data: {
      media_id: string;
      source_attempt_id: string;
      duplicate: boolean;
      ingest_enqueued: boolean;
    };
  };
  expect(
    confirmed.data,
    `Upload confirmation changed the accepted identity for media ${init.data.media_id}.`,
  ).toMatchObject({
    media_id: init.data.media_id,
    source_attempt_id: init.data.source_attempt_id,
    duplicate: false,
    ingest_enqueued: true,
  });

  await expect
    .poll(
      async () => {
        const response = await api.get(
          `/api/media/${init.data.media_id}`,
        );
        if (!response.ok()) return `http-${response.status()}`;
        const payload = (await response.json()) as {
          data: { processing_status: string };
        };
        return payload.data.processing_status;
      },
      {
        message: `Expected worker-owned media ${init.data.media_id} to reach ready_for_reading.`,
        timeout: 25_000,
      },
    )
    .toBe("ready_for_reading");

  await gotoWithStrictCsp(page, `/libraries/${defaultLibraryId}`);
  const published = page.locator(
    `main a[href="/media/${init.data.media_id}"]`,
  );
  await expect(
    published,
    `Worker-owned media ${init.data.media_id} was ready but absent from default Library ${defaultLibraryId}.`,
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    published,
    `Default Library ${defaultLibraryId} published media ${init.data.media_id} without the independently known EPUB title.`,
  ).toHaveAccessibleName("Canonical Reader Positions");
  await published.click();
  await expect(page).toHaveURL(
    new RegExp(`/media/${init.data.media_id}(?:[?#]|$)`),
  );
  await expect(
    page.getByRole("heading", { name: "Canonical Reader Positions" }),
    `Reader did not project the independently known EPUB title for media ${init.data.media_id}.`,
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "EPUB controls" }),
    `Reader for media ${init.data.media_id} did not publish EPUB navigation.`,
  ).toBeVisible();
  await expect(
    page.getByLabel("Select section"),
    `Reader for media ${init.data.media_id} did not load its persisted EPUB sections.`,
  ).toBeVisible();
});

test("bounded Heavy ingest preserves API and Light-worker service through complete indexing and typed rejection", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const directApi = pageRequest(page, apiOrigin);
  const objects = pageRequest(page, minioOrigin);
  const chatEvidenceMediaId = await captureCanonicalArticle(
    page,
    "bounded-interactive-proof",
  );
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${chatEvidenceMediaId}`);
        if (!response.ok()) return `http-${response.status()}`;
        return (
          (await response.json()) as {
            data: { retrieval_status: string | null };
          }
        ).data.retrieval_status;
      },
      {
        message: `Interactive proof source ${chatEvidenceMediaId} never became searchable before Heavy work began.`,
        timeout: 25_000,
      },
    )
    .toBe("ready");
  const bounded = await acceptPdfUpload(
    api,
    objects,
    boundedCitationPdf(),
    "bounded-media-processing-evidence-corpus.pdf",
    `bounded-pdf-${journeyUser.id}`,
  );

  await expect
    .poll(
      async () => {
        const item = await activityItem(api, bounded.media_id);
        const progress =
          item?.state.kind === "Active" && item.state.progress.kind === "Present"
            ? item.state.progress.value
            : undefined;
        return item?.state.kind === "Active" &&
          item.state.status === "Processing" &&
          progress?.kind === "Counted" &&
          progress.unit === "Page" &&
          progress.total === 712 &&
          progress.completed > 0 &&
          progress.completed < progress.total
          ? "active"
          : JSON.stringify(item ?? null);
      },
      {
        message: `Heavy source ${bounded.media_id} never exposed in-flight counted 712-page progress.`,
        timeout: 25_000,
      },
    )
    .toBe("active");

  // The active Heavy import is real worker-owned state. Account is its only
  // navigation owner: opening Import activity must present that same active work
  // in Nexus, without inventing a pane route or relying on a component stub.
  await gotoWithStrictCsp(page, "/");
  const account = page.getByRole("button", { name: /^Account(?:,|$)/ });
  await expect(
    account,
    `The active Heavy import ${bounded.media_id} did not surface through the Account menu.`,
  ).toHaveAttribute("data-import-count", "1", { timeout: 15_000 });
  await account.click();
  const accountMenu = page.getByRole("menu");
  await expect(accountMenu).toBeVisible();
  await accountMenu
    .getByRole("menuitem", { name: "Import activity", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
    "Import activity from Account did not open the real Nexus Activity surface.",
  ).toBeVisible();
  await expect(
    page.getByText("1 in progress", { exact: true }),
    `Nexus Activity did not project the independently observed active import ${bounded.media_id}.`,
  ).toBeVisible();

  const readiness = await directApi.get("/readyz");
  expect(
    readiness.ok(),
    `API readiness failed during Heavy source ${bounded.media_id}: ${readiness.status()} ${await readiness.text()}`,
  ).toBeTruthy();
  const profile = await api.get("/api/me");
  expect(
    profile.ok(),
    `Authenticated read failed during Heavy source ${bounded.media_id}: ${profile.status()} ${await profile.text()}`,
  ).toBeTruthy();

  const rejected = await acceptPdfUpload(
    api,
    objects,
    adversarialTruncatedPdf(),
    "truncated-parser-boundary.pdf",
    `truncated-pdf-${journeyUser.id}`,
  );
  const conversationResponse = await api.post("/api/conversations", {
    headers: { origin: webOrigin },
    data: {
      initial_context_refs: [`media:${chatEvidenceMediaId}`],
    },
  });
  const conversation = (await readBody(conversationResponse)) as {
    data: { id: string };
  };
  const chatResponse = await api.post("/api/chat-runs", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": `bounded-interactive-${randomUUID()}`,
      [TOOL_PROJECTION_HEADER]: TOOL_PROJECTION_REVISION,
    },
    data: {
      destination: {
        kind: "Existing",
        conversation_id: conversation.data.id,
        insertion: { kind: "Empty" },
      },
      content:
        "What did SOFIA establish about water in Clavius Crater? Use the attached source.",
      profile_id: "fast",
      reasoning_option_id: "high",
      reader_selection: { kind: "Absent" },
    },
  });
  const admittedChat = (await readBody(chatResponse)) as {
    data: { run: { id: string; status: string } };
  };
  expect(
    admittedChat.data.run.status,
    `Interactive chat ${admittedChat.data.run.id} was not durably queued during Heavy source ${bounded.media_id}.`,
  ).toBe("queued");
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/chat-runs/${admittedChat.data.run.id}`, {
          headers: { [TOOL_PROJECTION_HEADER]: TOOL_PROJECTION_REVISION },
        });
        if (!response.ok()) return `http-${response.status()}`;
        const payload = (await response.json()) as {
          data: {
            run: { status: string };
            assistant_message: {
              status: string;
              message_document: {
                blocks: Array<{ type: string; text?: string }>;
              };
            };
          };
        };
        if (
          payload.data.run.status !== "complete" ||
          payload.data.assistant_message.status !== "complete"
        ) {
          return payload.data.run.status;
        }
        return payload.data.assistant_message.message_document.blocks.some(
          (block) => block.type === "text" && block.text?.includes("Clavius Crater"),
        );
      },
      {
        message: `Interactive worker did not complete chat ${admittedChat.data.run.id} during Heavy source ${bounded.media_id}.`,
        timeout: 25_000,
      },
    )
    .toBe(true);

  const duringLightCompletion = await activityItem(api, bounded.media_id);
  expect(
    duringLightCompletion?.state.kind === "Active",
    `Heavy work ${bounded.media_id} completed before the Light-worker outcome was observed: ${JSON.stringify(duringLightCompletion ?? null)}.`,
  ).toBeTruthy();

  await expect
    .poll(
      async () => {
        const item = await activityItem(api, bounded.media_id);
        return item === undefined ? "complete" : JSON.stringify(item);
      },
      {
        message: `Bounded source ${bounded.media_id} did not complete its Heavy content-index operation.`,
        timeout: 45_000,
      },
    )
    .toBe("complete");
  await expect
    .poll(
      async () => {
        const item = await activityItem(api, rejected.media_id);
        return item?.state.kind === "NeedsAttention" &&
          item.state.failure_code.kind === "Present"
          ? item.state.failure_code.value
          : JSON.stringify(item ?? null);
      },
      {
        message: `Adversarial source ${rejected.media_id} did not publish its exact typed parser rejection.`,
        timeout: 25_000,
      },
    )
    .toBe("E_INVALID_FILE_TYPE");
});
