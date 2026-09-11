import { randomUUID } from "node:crypto";
import type { APIResponse } from "playwright/test";
import { TOOL_PROJECTION_HEADER } from "@/lib/api/client";
import { decodeChatAdmissionResponse } from "@/lib/conversations/chatAdmission";
import { decodeChatRunData } from "@/lib/conversations/messageWire";
import { TOOL_PROJECTION_REVISION } from "@/lib/conversations/toolContractProjection";
import { captureReadableArticle } from "../articleFixture";
import {
  adversarialTruncatedPdf,
  boundedCitationPdf,
  uniqueCanonicalReaderEpub,
} from "../corpus";
import { uploadDocument } from "../documentUploadFixture";
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

function acceptedChatTarget(raw: unknown, commandKey: string) {
  const receipt = decodeChatAdmissionResponse(raw, commandKey);
  if (receipt.outcome.kind !== "Accepted")
    throw new Error("Interactive chat was not admitted during Heavy work");
  return receipt.outcome;
}

interface ActivityItem {
  kind: "Media";
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
): Promise<{ media_id: string; source_attempt_id: string }> {
  const published = await uploadDocument({
    api,
    objects,
    payload,
    kind: "Pdf",
    filename,
    idempotencyKey,
  });
  return {
    media_id: published.mediaId,
    source_attempt_id: published.sourceAttemptId,
  };
}

async function activityItem(
  api: ExactOriginRequest,
  mediaId: string,
): Promise<ActivityItem | undefined> {
  const response = await api.get("/api/media/activity?limit=20");
  const payload = (await readBody(response)) as {
    data: { items: Array<ActivityItem | { kind: "UploadSession" }> };
  };
  return payload.data.items.find(
    (item): item is ActivityItem => item.kind === "Media" && item.media_id === mediaId,
  );
}

test("an accepted EPUB publishes in the default Library and opens through its real row", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  // The bounded-child executor runs each Heavy job in a fresh process, so a
  // document’s ingest/enrich/reindex pipeline plus the fresh-database
  // maintenance backlog needs materially more wall time on CI than the
  // pre-cutover in-process worker.
  test.setTimeout(300_000);
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
  const removedInit = await api.post("/api/media/upload/init", {
    headers: { origin: webOrigin },
    data: {},
  });
  expect(
    removedInit.status(),
    "The provisional-media upload route must be absent after the hard cut.",
  ).toBe(404);
  const epub = uniqueCanonicalReaderEpub(journeyUser.id);
  const published = await uploadDocument({
    api,
    objects,
    payload: epub,
    kind: "Epub",
    filename: "canonical-reader-durable-ingest.epub",
    idempotencyKey: `durable-ingest-${journeyUser.id}`,
    beforeConfirm: async ({ session_handle: sessionHandle }) => {
      const response = await api.get("/api/media/activity?limit=20");
      const activity = (await readBody(response)) as {
        data: { items: Array<{ kind: string; session_handle?: string }> };
      };
      expect(
        activity.data.items.some(
          (item) =>
            item.kind === "UploadSession" &&
            item.session_handle === sessionHandle,
        ),
        "An uploaded but unconfirmed session must not publish media or create an Activity obligation.",
      ).toBe(false);
    },
  });
  const mediaId = published.mediaId;
  const removedConfirm = await api.post(`/api/media/${mediaId}/ingest`, {
    headers: { origin: webOrigin },
    data: {},
  });
  expect(
    removedConfirm.status(),
    "The media-scoped upload confirmation route must be absent after the hard cut.",
  ).toBe(404);

  await expect
    .poll(
      async () => {
        const response = await api.get(
          `/api/media/${mediaId}`,
        );
        if (!response.ok()) return `http-${response.status()}`;
        const payload = (await response.json()) as {
          data: { processing_status: string };
        };
        return payload.data.processing_status;
      },
      {
        message: `Expected worker-owned media ${mediaId} to reach ready_for_reading.`,
        timeout: 90_000,
      },
    )
    .toBe("ready_for_reading");

  await gotoWithStrictCsp(page, `/libraries/${defaultLibraryId}`);
  const libraryRow = page.locator(
    `main a[href="/media/${mediaId}"]`,
  );
  await expect(
    libraryRow,
    `Worker-owned media ${mediaId} was ready but absent from default Library ${defaultLibraryId}.`,
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    libraryRow,
    `Default Library ${defaultLibraryId} published media ${mediaId} without the independently known EPUB title.`,
  ).toHaveAccessibleName("Canonical Reader Positions");
  await libraryRow.click();
  await expect(page).toHaveURL(
    new RegExp(`/media/${mediaId}(?:[?#]|$)`),
  );
  await expect(
    page.getByRole("heading", { name: "Canonical Reader Positions" }),
    `Reader did not project the independently known EPUB title for media ${mediaId}.`,
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "EPUB controls" }),
    `Reader for media ${mediaId} did not publish EPUB navigation.`,
  ).toBeVisible();
  await expect(
    page.getByLabel("Select section"),
    `Reader for media ${mediaId} did not load its persisted EPUB sections.`,
  ).toBeVisible();
});

test("bounded Heavy ingest preserves API and Light-worker service through complete indexing and typed rejection", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  // The bounded-child executor runs each Heavy job in a fresh process, so a
  // document’s ingest/enrich/reindex pipeline plus the fresh-database
  // maintenance backlog needs materially more wall time on CI than the
  // pre-cutover in-process worker.
  test.setTimeout(300_000);
  const api = pageRequest(page, webOrigin);
  const directApi = pageRequest(page, apiOrigin);
  const objects = pageRequest(page, minioOrigin);
  const chatEvidenceMediaId = await captureReadableArticle(
    page,
    "bounded-interactive-proof",
  );
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
        timeout: 90_000,
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
  ).toHaveAttribute("data-import-count", "1", { timeout: 60_000 });
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
  const catalogResponse = await api.get("/api/llm-catalog");
  const catalog = (await readBody(catalogResponse)) as {
    data: {
      definition_revision: string;
      chat_seed: { selection: unknown };
    };
  };
  const chatCommandKey = `bounded-interactive-${randomUUID()}`;
  const chatResponse = await api.post("/api/chat-runs", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": chatCommandKey,
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
      catalog_definition_revision: catalog.data.definition_revision,
      selection: catalog.data.chat_seed.selection,
      tool_authority: "ReadOnly",
      reader_selection: { kind: "Absent" },
    },
  });
  const admittedChat = acceptedChatTarget(
    await readBody(chatResponse),
    chatCommandKey,
  );
  expect(admittedChat.conversation_id).toBe(conversation.data.id);
  const admittedResponse = await api.get(`/api/chat-runs/${admittedChat.run_id}`, {
    headers: { [TOOL_PROJECTION_HEADER]: TOOL_PROJECTION_REVISION },
  });
  const admitted = decodeChatRunData(
    ((await readBody(admittedResponse)) as { data: unknown }).data,
  );
  expect(
    {
      run_id: admitted.run.id,
      run_conversation_id: admitted.run.conversation_id,
      conversation_id: admitted.conversation.id,
      run_assistant_message_id: admitted.run.assistant_message_id,
      assistant_message_id: admitted.assistant_message.id,
    },
    `Interactive admission identities changed while Heavy source ${bounded.media_id} was running.`,
  ).toEqual({
    run_id: admittedChat.run_id,
    run_conversation_id: admittedChat.conversation_id,
    conversation_id: admittedChat.conversation_id,
    run_assistant_message_id: admittedChat.assistant_message_id,
    assistant_message_id: admittedChat.assistant_message_id,
  });
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/chat-runs/${admittedChat.run_id}`, {
          headers: { [TOOL_PROJECTION_HEADER]: TOOL_PROJECTION_REVISION },
        });
        if (!response.ok()) return `http-${response.status()}`;
        const payload = decodeChatRunData(
          ((await response.json()) as { data: unknown }).data,
        );
        if (
          payload.run.status !== "complete" ||
          payload.assistant_message.status !== "complete"
        ) {
          return payload.run.status;
        }
        const messageDocument = payload.assistant_message.message_document;
        if (messageDocument === undefined) return "missing-message-document";
        return messageDocument.blocks.some(
          (block) => block.type === "text" && block.text?.includes("Clavius Crater"),
        );
      },
      {
        message: `Interactive worker did not complete chat ${admittedChat.run_id} during Heavy source ${bounded.media_id}.`,
        timeout: 90_000,
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
        timeout: 120_000,
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
        timeout: 90_000,
      },
    )
    .toBe("E_INVALID_FILE_TYPE");
});
