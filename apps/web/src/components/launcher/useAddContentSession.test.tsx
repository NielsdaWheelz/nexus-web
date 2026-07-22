import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddSeed } from "@/lib/launcher/model";
import {
  useAddContentSession,
  type AddContentSessionController,
} from "./useAddContentSession";

const CONTENT_SEED: AddSeed = {
  kind: "Content",
  initialFocus: "Url",
  initialDestinations: [],
};

function Harness({
  onRender,
}: {
  onRender(session: AddContentSessionController): void;
}) {
  onRender(useAddContentSession());
  return null;
}

describe("useAddContentSession mutation lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["Stop", "replacement"] as const)(
    "rejects a destination created after %s supersedes its session",
    async (supersedingAction) => {
      let session!: AddContentSessionController;
      let resolveRequest!: (response: Response) => void;
      let requestSignal: AbortSignal | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        expect(url.pathname).toBe("/api/libraries");
        expect(init?.method).toBe("POST");
        requestSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        });
      });
      render(<Harness onRender={(next) => (session = next)} />);

      act(() => session.start(CONTENT_SEED));
      let creation!: Promise<
        Awaited<ReturnType<AddContentSessionController["createDestination"]>>
      >;
      act(() => {
        creation = session.createDestination("Stale destination");
      });
      await waitFor(() => expect(session.state.mutation.kind).toBe("Running"));
      expect(requestSignal?.aborted).toBe(false);

      act(() => {
        if (supersedingAction === "Stop") {
          session.stop();
        } else {
          session.start({
            kind: "Content",
            initialFocus: "File",
            initialDestinations: [],
          });
        }
      });
      expect(requestSignal?.aborted).toBe(true);
      expect(session.state.mutation.kind).toBe("Idle");

      await act(async () => {
        resolveRequest(
          jsonResponse({
            data: {
              id: "library-stale",
              name: "Stale destination",
              color: null,
              created_at: "2026-07-21T12:00:00Z",
              updated_at: "2026-07-21T12:00:00Z",
            },
          }),
        );
        await expect(creation).rejects.toMatchObject({ name: "AbortError" });
      });

      expect(session.state.mutation.kind).toBe("Idle");
      expect(session.state.defaultDestinations).toEqual([]);
    },
  );

  it("aborts Stop, blocks competing intent, and ignores a stale completion", async () => {
    let session!: AddContentSessionController;
    let resolveRequest!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new URL(String(input), "http://localhost").pathname).toBe(
        "/api/media/from-url",
      );
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
    });
    render(<Harness onRender={(next) => (session = next)} />);

    act(() => session.start(CONTENT_SEED));
    act(() => session.setUrlText("https://example.com/deferred"));
    act(() => expect(session.reviewUrls()).toBe(true));

    let submission!: Promise<void>;
    act(() => {
      submission = session.submit();
    });
    await waitFor(() => expect(session.state.mutation.kind).toBe("Running"));
    expect(requestSignal?.aborted).toBe(false);

    await waitFor(() => {
      const event = new Event("beforeunload", { cancelable: true });
      expect(window.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    });

    act(() => session.setUrlText("https://example.com/competing"));
    expect(session.state.urlInput.text).toBe("");

    act(() => session.stop());
    expect(requestSignal?.aborted).toBe(true);
    expect(session.state.mutation.kind).toBe("Idle");
    expect(session.state.items[0]).toMatchObject({
      kind: "AcceptanceUnresolved",
      feedback: {
        severity: "warning",
        title: "Stopped · acceptance status unknown",
      },
    });
    await waitFor(() => {
      const event = new Event("beforeunload", { cancelable: true });
      expect(window.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    await act(async () => {
      resolveRequest(
        new Response(
          JSON.stringify({
            data: {
              media_id: "55555555-5555-4555-8555-555555555555",
              source_attempt_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              source_type: "generic_web_url",
              source_attempt_status: "queued",
              idempotency_outcome: "created",
              processing_status: "pending",
              ingest_enqueued: true,
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      await submission;
    });

    expect(session.state.mutation.kind).toBe("Idle");
    expect(session.state.items[0]?.kind).toBe("AcceptanceUnresolved");
  });

  it("restores queued work that never crossed the bounded request boundary on Stop", async () => {
    let session!: AddContentSessionController;
    const startedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/media/from-url");
      const body = JSON.parse(String(init?.body)) as { url: string };
      startedUrls.push(body.url);
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(new DOMException("The request was aborted.", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    render(<Harness onRender={(next) => (session = next)} />);

    act(() => session.start(CONTENT_SEED));
    act(() =>
      session.setUrlText(
        [
          "https://example.com/one",
          "https://example.com/two",
          "https://example.com/three",
        ].join("\n"),
      ),
    );
    act(() => expect(session.reviewUrls()).toBe(true));
    let submission!: Promise<void>;
    act(() => {
      submission = session.submit();
    });
    await waitFor(() => expect(startedUrls).toHaveLength(2));

    act(() => session.stop());
    await act(async () => submission);

    expect(startedUrls).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
    expect(session.state.items).toMatchObject([
      { kind: "AcceptanceUnresolved" },
      { kind: "AcceptanceUnresolved" },
      {
        kind: "Draft",
        source: { kind: "Url", url: "https://example.com/three" },
      },
    ]);
  });

  it("fails closed with accepted upload identity when a same-system response defects", async () => {
    const mediaId = "44444444-4444-4444-8444-444444444444";
    const sourceAttemptId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/media/upload/init")) {
        return jsonResponse({
          data: {
            media_id: mediaId,
            source_attempt_id: sourceAttemptId,
            source_type: "upload",
            source_attempt_status: "accepted",
            idempotency_outcome: "created",
            processing_status: "pending",
            ingest_enqueued: false,
            upload_url: "https://uploads.example/defect.pdf",
            expires_at: "2026-01-01T00:00:00Z",
          },
        });
      }
      if (
        url === "https://uploads.example/defect.pdf" &&
        init?.method === "PUT"
      ) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith(`/api/media/${mediaId}/ingest`)) {
        return new Response("<!doctype html><title>Unexpected</title>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(<Harness onRender={(next) => (session = next)} />);

    act(() => session.start(CONTENT_SEED));
    act(() =>
      expect(
        session.stageFiles([
          new File(["%PDF-1.7"], "defect.pdf", { type: "application/pdf" }),
        ]),
      ).toBe(true),
    );
    await act(async () => {
      await expect(session.submit()).rejects.toThrow(
        "API returned a non-JSON response",
      );
    });

    expect(session.state.mutation.kind).toBe("Running");
    expect(session.state.items[0]).toMatchObject({
      kind: "Submitting",
    });

    act(() => session.stop());
    expect(session.state.items[0]).toMatchObject({
      kind: "AcceptedUncertain",
      mediaId,
      sourceAttemptId,
      feedback: { title: "Stopped · acceptance status unknown" },
    });
  });

  it("restores the frozen Draft without product feedback when acceptance decoding defects", async () => {
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: {} }));
    render(<Harness onRender={(next) => (session = next)} />);

    act(() => session.start(CONTENT_SEED));
    act(() => session.setUrlText("https://example.com/acceptance-defect"));
    act(() => expect(session.reviewUrls()).toBe(true));
    await act(async () => {
      await expect(session.submit()).rejects.toThrow(
        "Invalid URL ingest response",
      );
    });

    expect(session.state.mutation.kind).toBe("Idle");
    expect(session.state.items[0]).toMatchObject({
      kind: "Draft",
      source: { kind: "Url", url: "https://example.com/acceptance-defect" },
    });
  });

  it("restores the selected OPML file when the same-system request defects", async () => {
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      apiErrorResponse(500, "E_INTERNAL"),
    );
    render(<Harness onRender={(next) => (session = next)} />);

    act(() => session.start({ kind: "Opml", initialDestinations: [] }));
    const file = new File(["<opml><body /></opml>"], "feeds.opml", {
      type: "text/xml",
    });
    act(() => session.setOpmlFile(file));
    await act(async () => {
      await expect(session.importOpml()).rejects.toMatchObject({
        code: "E_INTERNAL",
      });
    });

    expect(session.state.mutation.kind).toBe("Idle");
    expect(session.state.opml).toEqual({ kind: "Ready", file });
  });

  it("restores Unloaded after an authoritative membership read defects", async () => {
    const mediaId = "33333333-3333-4333-8333-333333333333";
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        return acceptedUrlResponse(mediaId);
      }
      if (
        url.pathname === `/api/media/${mediaId}/libraries` &&
        init?.method === "GET"
      ) {
        return apiErrorResponse(500, "E_INTERNAL");
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    });
    render(<Harness onRender={(next) => (session = next)} />);
    await acceptUrl(session, "https://example.com/membership-defect");

    await act(async () => {
      await expect(session.refreshMemberships([mediaId])).rejects.toMatchObject(
        {
          code: "E_INTERNAL",
        },
      );
    });

    expect(session.state.membershipByMediaId.get(mediaId)).toEqual({
      kind: "Unloaded",
    });
  });

  it("restores a concurrent membership read when another mutation is stopped", async () => {
    const mediaId = "31313131-3131-4131-8131-313131313131";
    const libraryId = "41414141-4141-4141-8141-414141414141";
    let membershipReads = 0;
    let urlWrites = 0;
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        urlWrites += 1;
        if (urlWrites === 1) return acceptedUrlResponse(mediaId);
        const signal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () =>
            reject(new DOMException("The request was aborted.", "AbortError"));
          if (signal.aborted) rejectAbort();
          else signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      if (
        url.pathname === `/api/media/${mediaId}/libraries` &&
        init?.method === "GET"
      ) {
        membershipReads += 1;
        if (membershipReads === 2) {
          const signal = init.signal as AbortSignal;
          return new Promise<Response>((_resolve, reject) => {
            const rejectAbort = () =>
              reject(
                new DOMException("The request was aborted.", "AbortError"),
              );
            if (signal.aborted) rejectAbort();
            else signal.addEventListener("abort", rejectAbort, { once: true });
          });
        }
        return jsonResponse({
          data: [
            {
              id: libraryId,
              name: "Research",
              color: null,
              is_in_library: true,
              can_add: false,
              can_remove: true,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method} ${url.pathname}`);
    });
    render(<Harness onRender={(next) => (session = next)} />);
    await acceptUrl(session, "https://example.com/accepted");
    await act(async () => session.refreshMemberships([mediaId]));
    expect(session.state.membershipByMediaId.get(mediaId)).toMatchObject({
      kind: "Ready",
      libraries: [{ id: libraryId, isInLibrary: true }],
    });

    let refresh!: Promise<void>;
    act(() => {
      refresh = session.refreshMemberships([mediaId]);
    });
    await waitFor(() =>
      expect(session.state.membershipByMediaId.get(mediaId)?.kind).toBe(
        "Loading",
      ),
    );
    act(() => session.setUrlText("https://example.com/deferred"));
    act(() => expect(session.reviewUrls()).toBe(true));
    let submission!: Promise<void>;
    act(() => {
      submission = session.submit();
    });
    await waitFor(() => expect(session.state.mutation.kind).toBe("Running"));

    act(() => session.stop());
    await act(async () => Promise.all([refresh, submission]));

    expect(session.state.membershipByMediaId.get(mediaId)).toMatchObject({
      kind: "Ready",
      libraries: [{ id: libraryId, isInLibrary: true }],
    });
    await act(async () => session.refreshMemberships([mediaId]));
    expect(membershipReads).toBe(3);
    expect(session.state.membershipByMediaId.get(mediaId)?.kind).toBe("Ready");
  });

  it("restores authoritative membership after reconciliation decoding defects", async () => {
    const mediaId = "22222222-2222-4222-8222-222222222222";
    const libraryId = "11111111-1111-4111-8111-111111111111";
    let membershipReads = 0;
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        return acceptedUrlResponse(mediaId);
      }
      if (
        url.pathname === `/api/media/${mediaId}/libraries` &&
        init?.method === "GET"
      ) {
        membershipReads += 1;
        return membershipReads === 1
          ? jsonResponse({
              data: [
                {
                  id: libraryId,
                  name: "Research",
                  color: null,
                  is_in_library: false,
                  can_add: true,
                  can_remove: false,
                },
              ],
            })
          : jsonResponse({ data: {} });
      }
      if (
        url.pathname === `/api/media/${mediaId}/libraries` &&
        init?.method === "POST"
      ) {
        throw new Error("Unclassified membership write failure");
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    });
    render(<Harness onRender={(next) => (session = next)} />);
    await acceptUrl(session, "https://example.com/membership-reconcile-defect");

    await act(async () => {
      await expect(
        session.runMembership({
          mediaIds: [mediaId],
          command: { kind: "Add", libraryId },
        }),
      ).rejects.toThrow("Invalid media-library memberships response");
    });

    expect(session.state.mutation.kind).toBe("Idle");
    expect(session.state.membershipByMediaId.get(mediaId)).toMatchObject({
      kind: "Ready",
      libraries: [{ id: libraryId, isInLibrary: false }],
    });
  });

  it("projects queued, started, and succeeded membership work truthfully on Stop", async () => {
    const libraryId = "91919191-9191-4191-8191-919191919191";
    const mediaIds = ["media-one", "media-two", "media-three", "media-four"];
    const startedWrites: string[] = [];
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { url: string };
        const suffix = body.url.split("/").at(-1);
        if (!suffix) throw new Error("Expected URL suffix");
        return jsonResponse({
          data: {
            media_id: `media-${suffix}`,
            source_attempt_id: `attempt-${suffix}`,
            source_type: "generic_web_url",
            source_attempt_status: "queued",
            idempotency_outcome: "created",
            processing_status: "pending",
            ingest_enqueued: true,
          },
        });
      }
      const membershipMatch = url.pathname.match(
        /^\/api\/media\/(media-[^/]+)\/libraries$/,
      );
      if (membershipMatch && init?.method === "GET") {
        return jsonResponse({
          data: [
            {
              id: libraryId,
              name: "Research",
              color: null,
              is_in_library: false,
              can_add: true,
              can_remove: false,
            },
          ],
        });
      }
      if (membershipMatch && init?.method === "POST") {
        const mediaId = membershipMatch[1];
        if (!mediaId) throw new Error("Expected media id");
        startedWrites.push(mediaId);
        if (mediaId === "media-one") {
          return new Response(null, { status: 204 });
        }
        const signal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () =>
            reject(new DOMException("The request was aborted.", "AbortError"));
          if (signal.aborted) rejectAbort();
          else signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method} ${url.pathname}`);
    });
    render(<Harness onRender={(next) => (session = next)} />);

    act(() => session.start(CONTENT_SEED));
    act(() =>
      session.setUrlText(
        ["one", "two", "three", "four"]
          .map((suffix) => `https://example.com/${suffix}`)
          .join("\n"),
      ),
    );
    act(() => expect(session.reviewUrls()).toBe(true));
    await act(async () => session.submit());
    expect(session.state.items).toHaveLength(4);

    let command!: Promise<void>;
    act(() => {
      command = session.runMembership({
        mediaIds,
        command: { kind: "Add", libraryId },
      });
    });
    await waitFor(() =>
      expect(startedWrites).toEqual(["media-one", "media-two", "media-three"]),
    );

    act(() => session.stop());
    await act(async () => command);

    expect(session.state.membershipByMediaId.get("media-one")).toMatchObject({
      kind: "Ready",
      libraries: [{ isInLibrary: true }],
    });
    expect(session.state.membershipByMediaId.get("media-two")).toMatchObject({
      kind: "CommandFailed",
    });
    expect(session.state.membershipByMediaId.get("media-three")).toMatchObject({
      kind: "CommandFailed",
    });
    expect(session.state.membershipByMediaId.get("media-four")).toMatchObject({
      kind: "Ready",
      libraries: [{ isInLibrary: false }],
    });
  });

  it("keeps replay-established upload identity fail-closed until explicit Stop", async () => {
    const mediaId = "12121212-1212-4212-8212-121212121212";
    const sourceAttemptId = "34343434-3434-4434-8434-343434343434";
    let initCalls = 0;
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/media/upload/init")) {
        initCalls += 1;
        if (initCalls === 1)
          throw new TypeError("Initial response was interrupted");
        return jsonResponse({
          data: {
            media_id: mediaId,
            source_attempt_id: sourceAttemptId,
            source_type: "upload",
            source_attempt_status: "accepted",
            idempotency_outcome: "reused",
            processing_status: "pending",
            ingest_enqueued: false,
            upload_url: "https://uploads.example/reconcile.pdf",
            expires_at: "2026-01-01T00:00:00Z",
          },
        });
      }
      if (
        url === "https://uploads.example/reconcile.pdf" &&
        init?.method === "PUT"
      ) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith(`/api/media/${mediaId}/ingest`)) {
        return new Response("<!doctype html><title>Unexpected</title>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(<Harness onRender={(next) => (session = next)} />);

    act(() => session.start(CONTENT_SEED));
    act(() =>
      expect(
        session.stageFiles([
          new File(["%PDF-1.7"], "reconcile.pdf", {
            type: "application/pdf",
          }),
        ]),
      ).toBe(true),
    );
    await act(async () => session.submit());
    expect(session.state.items[0]?.kind).toBe("AcceptanceUnresolved");
    const itemId = session.state.items[0]!.id;

    await act(async () => {
      await expect(session.reconcileAcceptance(itemId)).rejects.toThrow(
        "API returned a non-JSON response",
      );
    });
    expect(session.state.mutation).toMatchObject({
      kind: "Running",
      operation: { kind: "ReconcileAcceptance", itemId },
    });
    expect(session.state.items[0]?.kind).toBe("AcceptanceUnresolved");

    act(() => session.stop());
    expect(session.state.items[0]).toMatchObject({
      kind: "AcceptedUncertain",
      mediaId,
      sourceAttemptId,
      feedback: { title: "Stopped · acceptance status unknown" },
    });
  });

  it("preloads accepted-uncertain identity before replay can defect", async () => {
    const mediaId = "56565656-5656-4656-8656-565656565656";
    const sourceAttemptId = "78787878-7878-4878-8878-787878787878";
    let initCalls = 0;
    let session!: AddContentSessionController;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (!url.endsWith("/api/media/upload/init")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      initCalls += 1;
      if (initCalls === 2) return apiErrorResponse(500, "E_INTERNAL");
      return jsonResponse({
        data: {
          media_id: mediaId,
          source_attempt_id: sourceAttemptId,
          source_type: "upload",
          source_attempt_status: "accepted",
          idempotency_outcome: "created",
          processing_status: "pending",
          ingest_enqueued: false,
          upload_url: null,
          expires_at: null,
        },
      });
    });
    render(<Harness onRender={(next) => (session = next)} />);

    act(() => session.start(CONTENT_SEED));
    act(() =>
      expect(
        session.stageFiles([
          new File(["%PDF-1.7"], "uncertain.pdf", {
            type: "application/pdf",
          }),
        ]),
      ).toBe(true),
    );
    await act(async () => session.submit());
    const itemId = session.state.items[0]!.id;
    expect(session.state.items[0]).toMatchObject({
      kind: "AcceptedUncertain",
      mediaId,
      sourceAttemptId,
    });

    await act(async () => {
      await expect(session.reconcileAcceptance(itemId)).rejects.toMatchObject({
        code: "E_INTERNAL",
      });
    });
    expect(session.state.mutation).toMatchObject({
      kind: "Running",
      operation: { kind: "ReconcileAcceptance", itemId },
    });
    expect(session.state.items[0]).toMatchObject({
      kind: "AcceptedUncertain",
      mediaId,
      sourceAttemptId,
    });

    act(() => session.stop());
    expect(session.state.mutation.kind).toBe("Idle");
    expect(session.state.items[0]).toMatchObject({
      kind: "AcceptedUncertain",
      mediaId,
      sourceAttemptId,
    });
  });
});

async function acceptUrl(
  session: AddContentSessionController,
  url: string,
): Promise<void> {
  act(() => session.start(CONTENT_SEED));
  act(() => session.setUrlText(url));
  act(() => expect(session.reviewUrls()).toBe(true));
  await act(async () => session.submit());
}

function acceptedUrlResponse(mediaId: string): Response {
  return jsonResponse({
    data: {
      media_id: mediaId,
      source_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source_type: "generic_web_url",
      source_attempt_status: "queued",
      idempotency_outcome: "created",
      processing_status: "pending",
      ingest_enqueued: true,
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function apiErrorResponse(status: number, code: string): Response {
  return new Response(
    JSON.stringify({
      error: { code, message: code, request_id: `req-${code}` },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
