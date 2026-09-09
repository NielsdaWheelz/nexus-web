import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { subscribeImportsInvalidations } from "@/lib/imports/importsClient";
import {
  UploadSessionError,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import AddPanel from "./AddPanel";
import { useAddContentSession } from "./useAddContentSession";

/**
 * Oracle: the upload protocol of `docs/cutovers/imports-workspace-hard-cutover.md`
 * ("API and recovery admission") and the Add sheet's own contract — the
 * foreground lane owns a file until the confirm succeeds, and only then does
 * Imports own the session. These cases were the foreground half of the retired
 * Activity proof; they never proved Activity.
 */

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const UPLOAD_SESSION_HANDLE = "nup1.upload-session.signature";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function futureUploadExpiry(): string {
  return new Date(Date.now() + 300_000).toISOString();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function ForegroundUploadAddPanel(): React.ReactElement {
  const session = useAddContentSession();
  const [defect, setDefect] = useState<unknown>(null);
  return (
    <>
      {defect === null ? null : (
        <p>
          Add defect: {defect instanceof Error ? defect.message : String(defect)}
        </p>
      )}
      <AddPanel
        session={session}
        dismissalConfirmation={null}
        onBack={() => {}}
        onClose={() => {}}
        onKeepWorking={() => {}}
        onConfirmDismissal={() => {}}
        onOpen={() => {}}
        onDefect={(error) => setDefect(error)}
      />
    </>
  );
}

function renderForegroundUploadAddPanel() {
  return render(
    withRenderEnvironment(<ForegroundUploadAddPanel />, {
      initialViewport: "desktop",
    }),
  );
}

const FOREGROUND_UPLOAD_URL = "/signed-add-panel-upload";

function uploadRequiredPayload(): Record<string, unknown> {
  return {
    kind: "UploadRequired",
    session_handle: UPLOAD_SESSION_HANDLE,
    generation: 1,
    method: "PUT",
    upload_url: FOREGROUND_UPLOAD_URL,
    required_headers: { "Content-Type": "application/pdf" },
    expires_at: futureUploadExpiry(),
    idempotency_outcome: "Created",
  };
}

function needsAttentionPayload(failure: unknown): Record<string, unknown> {
  return {
    kind: "NeedsAttention",
    session_handle: UPLOAD_SESSION_HANDLE,
    failure,
    capabilities: { can_retry_upload: true, can_remove: true },
  };
}

async function stageForegroundPdf(): Promise<void> {
  renderForegroundUploadAddPanel();
  await userEvent.upload(
    screen.getByLabelText("Choose PDF or EPUB files"),
    new File([new Uint8Array([1])], "foreground.pdf", {
      type: "application/pdf",
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Add 1 item" }));
}

describe("Add sheet foreground upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps foreground file upload phases aligned with the HTTP boundary", async () => {
    const createSession = deferred<Response>();
    const directUpload = deferred<Response>();
    const reconciliationSession = deferred<Response>();
    const reconciliationUpload = deferred<Response>();
    const reconciliationConfirm = deferred<Response>();
    const requests: string[] = [];
    let createCount = 0;
    let uploadCount = 0;
    let confirmCount = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/media/uploads" && init?.method === "POST") {
          requests.push("create");
          createCount += 1;
          return createCount === 1
            ? createSession.promise
            : reconciliationSession.promise;
        }
        if (url.pathname === "/signed-add-panel-upload" && init?.method === "PUT") {
          requests.push("upload");
          uploadCount += 1;
          return uploadCount === 1
            ? directUpload.promise
            : reconciliationUpload.promise;
        }
        if (
          url.pathname === `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/confirm` &&
          init?.method === "POST"
        ) {
          requests.push("confirm");
          confirmCount += 1;
          return confirmCount === 1
            ? jsonResponse(
                {
                  error: {
                    code: "E_UPSTREAM",
                    message: "Confirmation status is temporarily unavailable",
                  },
                },
                503,
              )
            : reconciliationConfirm.promise;
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
      },
    );

    renderForegroundUploadAddPanel();
    await userEvent.upload(
      screen.getByLabelText("Choose PDF or EPUB files"),
      new File([new Uint8Array([1])], "foreground.pdf", {
        type: "application/pdf",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add 1 item" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Preparing…"),
    );
    expect(requests).toEqual(["create"]);

    createSession.resolve(
      jsonResponse({
        data: {
          kind: "UploadRequired",
          session_handle: UPLOAD_SESSION_HANDLE,
          generation: 1,
          method: "PUT",
          upload_url: "/signed-add-panel-upload",
          required_headers: { "Content-Type": "application/pdf" },
          expires_at: futureUploadExpiry(),
          idempotency_outcome: "Created",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Uploading…"),
    );
    expect(requests).toEqual(["create", "upload"]);

    directUpload.resolve(new Response(null, { status: 200 }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Verifying…"),
    );
    expect(requests).toEqual(["create", "upload", "confirm"]);

    expect(
      await screen.findByRole("button", { name: "Check status" }),
    ).toBeVisible();
    expect(screen.getByText("Acceptance status unknown")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Preparing…"),
    );
    expect(requests).toEqual(["create", "upload", "confirm", "create"]);

    reconciliationSession.resolve(
      jsonResponse({
        data: {
          kind: "UploadRequired",
          session_handle: UPLOAD_SESSION_HANDLE,
          generation: 2,
          method: "PUT",
          upload_url: "/signed-add-panel-upload",
          required_headers: { "Content-Type": "application/pdf" },
          expires_at: futureUploadExpiry(),
          idempotency_outcome: "Reused",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Uploading…"),
    );
    expect(requests).toEqual(["create", "upload", "confirm", "create", "upload"]);

    reconciliationUpload.resolve(new Response(null, { status: 200 }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Verifying…"),
    );
    expect(requests).toEqual([
      "create",
      "upload",
      "confirm",
      "create",
      "upload",
      "confirm",
    ]);

    reconciliationConfirm.resolve(
      jsonResponse({
        data: {
          kind: "Published",
          session_handle: UPLOAD_SESSION_HANDLE,
          media_id: MEDIA_ID,
          source_attempt_id: ATTEMPT_ID,
          idempotency_outcome: "Created",
        },
      }),
    );
    await waitFor(() => expect(screen.getByText("Saved")).toBeVisible());
    expect(requests).toEqual([
      "create",
      "upload",
      "confirm",
      "create",
      "upload",
      "confirm",
    ]);
  });

  it("bounds direct PUT and records Timeout instead of Aborted", async () => {
    const signedUploadStarted = deferred<void>();
    const transportFailures: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/media/uploads") {
          return jsonResponse({
            data: {
              kind: "UploadRequired",
              session_handle: UPLOAD_SESSION_HANDLE,
              generation: 1,
              method: "PUT",
              upload_url: "/signed-timeout-upload",
              required_headers: { "Content-Type": "application/pdf" },
              expires_at: new Date(Date.now() + 1_000).toISOString(),
              idempotency_outcome: "Created",
            },
          });
        }
        if (url.pathname === "/signed-timeout-upload" && init?.method === "PUT") {
          signedUploadStarted.resolve(undefined);
          return await new Promise<Response>((_resolve, reject) => {
            const uploadSignal = init.signal;
            if (uploadSignal === null || uploadSignal === undefined) {
              reject(new Error("Direct upload fetch has no abort signal"));
              return;
            }
            const rejectForAbort = () => reject(uploadSignal.reason);
            if (uploadSignal.aborted) {
              rejectForAbort();
            } else {
              uploadSignal.addEventListener("abort", rejectForAbort, { once: true });
            }
          });
        }
        if (
          url.pathname ===
            `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/transport-failure` &&
          init?.method === "POST"
        ) {
          transportFailures.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
      },
    );

    const upload = uploadIngestFile({
      file: new File([new Uint8Array([1])], "timeout.pdf", {
        type: "application/pdf",
      }),
      libraryIds: [],
      idempotencyKey: "media-upload-timeout",
    });
    await signedUploadStarted.promise;

    await expect(upload).rejects.toMatchObject({
      outcome: { kind: "NeedsAttention" },
    });
    await expect(upload).rejects.toBeInstanceOf(UploadSessionError);
    expect(transportFailures).toHaveLength(1);
    expect(transportFailures[0]).toMatchObject({
      kind: "Timeout",
      generation: 1,
    });
  });

  it.each([
    [
      "an unknown response kind",
      () => ({ ...uploadRequiredPayload(), kind: "upload_required" }),
    ],
    [
      "a missing discriminant",
      () => {
        const payload = uploadRequiredPayload();
        delete payload.kind;
        return payload;
      },
    ],
    [
      "an extra capability field",
      () => ({ ...uploadRequiredPayload(), upload_token: "leaked" }),
    ],
    [
      "a method the browser may not send",
      () => ({ ...uploadRequiredPayload(), method: "POST" }),
    ],
    [
      "an unfenced generation",
      () => ({ ...uploadRequiredPayload(), generation: 0 }),
    ],
    [
      "missing required headers",
      () => {
        const payload = uploadRequiredPayload();
        delete payload.required_headers;
        return payload;
      },
    ],
    [
      "a naive expiry instant",
      () => ({ ...uploadRequiredPayload(), expires_at: "2026-08-14T18:40:02" }),
    ],
    [
      "an open verification failure code",
      () =>
        needsAttentionPayload({
          kind: "VerificationFailed",
          code: "E_SOURCE_ENCRYPTED",
          failed_at: "2026-08-14T18:40:02Z",
        }),
    ],
    [
      "an unknown transport reason",
      () =>
        needsAttentionPayload({
          kind: "TransportFailed",
          reason: { kind: "Throttled" },
          failed_at: "2026-08-14T18:40:02Z",
        }),
    ],
  ])(
    "rejects %s from the upload endpoint instead of sending bytes",
    async (_label, payload) => {
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input), window.location.origin);
          requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
          if (url.pathname === "/api/media/uploads") {
            return jsonResponse({ data: payload() });
          }
          throw new Error(
            `Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`,
          );
        },
      );

      await stageForegroundPdf();

      expect(
        await screen.findByText(/returned an invalid response/),
        "a compatibility upload payload was accepted instead of defecting",
      ).toBeVisible();
      expect(
        requests.filter((request) => request.includes(FOREGROUND_UPLOAD_URL)),
        "the browser sent bytes for a capability it could not decode",
      ).toEqual([]);
    },
  );

  it("retries the same file under one intent when confirmation finds no staged bytes", async () => {
    const idempotencyKeys: (string | null)[] = [];
    const putBodies: { name: string; size: number }[] = [];
    let confirms = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/media/uploads" && init?.method === "POST") {
          idempotencyKeys.push(
            new Headers(init.headers).get("Idempotency-Key"),
          );
          return jsonResponse({
            data: {
              ...uploadRequiredPayload(),
              generation: idempotencyKeys.length,
              idempotency_outcome:
                idempotencyKeys.length === 1 ? "Created" : "Reused",
            },
          });
        }
        if (url.pathname === FOREGROUND_UPLOAD_URL && init?.method === "PUT") {
          const body = init.body;
          if (!(body instanceof File)) {
            throw new Error("Direct upload did not send the chosen File");
          }
          putBodies.push({ name: body.name, size: body.size });
          return new Response(null, { status: 200 });
        }
        if (
          url.pathname ===
            `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/confirm` &&
          init?.method === "POST"
        ) {
          confirms += 1;
          return confirms === 1
            ? jsonResponse(
                {
                  error: {
                    code: "E_STORAGE_MISSING",
                    message: "No staged object for this generation.",
                  },
                },
                400,
              )
            : jsonResponse({
                data: {
                  kind: "Published",
                  session_handle: UPLOAD_SESSION_HANDLE,
                  media_id: MEDIA_ID,
                  source_attempt_id: ATTEMPT_ID,
                  idempotency_outcome: "Created",
                },
              });
        }
        throw new Error(
          `Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`,
        );
      },
    );

    await stageForegroundPdf();

    expect(await screen.findByText("Upload didn’t complete")).toBeVisible();
    expect(
      screen.getByText(/Nexus never received this file/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Remove foreground.pdf" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/did not finish/i),
      "a confirmation with no staged bytes was reported as a transport failure",
    ).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeVisible());
    expect(putBodies).toEqual([
      { name: "foreground.pdf", size: 1 },
      { name: "foreground.pdf", size: 1 },
    ]);
    expect(idempotencyKeys).toHaveLength(2);
    expect(
      idempotencyKeys[0],
      "the retried upload changed intent instead of replaying one key",
    ).toBe(idempotencyKeys[1]);
    expect(idempotencyKeys[0]).not.toBeNull();
  });

  it("drops a superseded foreground attempt and lets Imports own the session", async () => {
    let invalidations = 0;
    const unsubscribe = subscribeImportsInvalidations(() => {
      invalidations += 1;
    });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/media/uploads" && init?.method === "POST") {
          return jsonResponse({ data: uploadRequiredPayload() });
        }
        if (url.pathname === FOREGROUND_UPLOAD_URL && init?.method === "PUT") {
          return new Response(null, { status: 200 });
        }
        if (
          url.pathname ===
            `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/confirm` &&
          init?.method === "POST"
        ) {
          return jsonResponse(
            {
              error: {
                code: "E_UPLOAD_GENERATION_STALE",
                message: "Another generation superseded this attempt.",
              },
            },
            409,
          );
        }
        throw new Error(
          `Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`,
        );
      },
    );

    try {
      await stageForegroundPdf();

      await waitFor(() =>
        expect(
          screen.queryByText("foreground.pdf"),
          "a superseded attempt kept claiming the item in the Add sheet",
        ).toBeNull(),
      );
      expect(
        screen
          .queryAllByRole("alert")
          .map((alert) => alert.textContent)
          .filter((text) => text !== null && text.length > 0),
      ).toEqual([]);
      expect(
        screen.queryByText(/returned an invalid response/),
        "a modeled stale generation was laundered into a contract defect",
      ).toBeNull();
      expect(
        invalidations,
        "the superseded attempt did not hand the session to Imports",
      ).toBeGreaterThanOrEqual(1);
    } finally {
      unsubscribe();
    }
  });

  it("publishes no Imports invalidation until the confirm succeeds", async () => {
    const confirmation = deferred<Response>();
    let confirms = 0;
    let invalidations = 0;
    const unsubscribe = subscribeImportsInvalidations(() => {
      invalidations += 1;
    });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/media/uploads" && init?.method === "POST") {
          return jsonResponse({ data: uploadRequiredPayload() });
        }
        if (url.pathname === FOREGROUND_UPLOAD_URL && init?.method === "PUT") {
          return new Response(null, { status: 200 });
        }
        if (
          url.pathname ===
            `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/confirm` &&
          init?.method === "POST"
        ) {
          confirms += 1;
          return confirmation.promise;
        }
        throw new Error(
          `Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`,
        );
      },
    );

    try {
      const upload = uploadIngestFile({
        file: new File([new Uint8Array([1])], "foreground.pdf", {
          type: "application/pdf",
        }),
        libraryIds: [],
        idempotencyKey: "media-upload-unpublished",
      });

      await waitFor(() =>
        expect(confirms, "the confirm never reached the boundary").toBe(1),
      );
      expect(
        invalidations,
        "foreground upload work claimed an Imports row before it published",
      ).toBe(0);

      confirmation.resolve(
        jsonResponse({
          data: {
            kind: "Published",
            session_handle: UPLOAD_SESSION_HANDLE,
            media_id: MEDIA_ID,
            source_attempt_id: ATTEMPT_ID,
            idempotency_outcome: "Created",
          },
        }),
      );
      await upload;

      await waitFor(() => expect(invalidations).toBe(1));
    } finally {
      unsubscribe();
    }
  });
});
