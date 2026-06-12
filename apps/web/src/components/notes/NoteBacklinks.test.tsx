import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import NoteBacklinks from "./NoteBacklinks";
import type { EdgeOut } from "@/lib/resourceGraph/edges";

const BLOCK_A = "11111111-1111-4111-8111-111111111111";
const BLOCK_B = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";

const SCANNABLE_EMPTY_COPY =
  "No connections yet. Scan to find resonant material, or link one manually.";

function edge(overrides: Partial<EdgeOut>): EdgeOut {
  return {
    id: "edge-1",
    kind: "context",
    origin: "note_body",
    source_ref: `note_block:${BLOCK_A}`,
    target_ref: "page:33333333-3333-4333-8333-333333333333",
    source_order_key: null,
    target_order_key: null,
    ordinal: null,
    snapshot: null,
    source_label: "This block",
    source_missing: false,
    target_label: "Linked page",
    target_missing: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

interface PendingRequest {
  path: string;
  init?: RequestInit;
  resolve: (response: Response) => void;
}

/** Promise-queue fetch stub: every request parks until the test resolves it. */
function stubFetchQueue(): PendingRequest[] {
  const requests: PendingRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({ path: String(input), init, resolve });
        }),
    ),
  );
  return requests;
}

// The mount status probe (poll resume) interleaves with edge reads, so tests
// address requests by path instead of arrival index.
const edgeReads = (requests: PendingRequest[]) =>
  requests.filter((request) =>
    request.path.startsWith("/api/resource-graph/edges?"),
  );
const scanStatusReads = (requests: PendingRequest[]) =>
  requests.filter((request) => request.path.startsWith("/api/synapse/scans?"));
const scanPosts = (requests: PendingRequest[]) =>
  requests.filter((request) => request.path === "/api/synapse/scans");

const idleStatusResponse = () =>
  Response.json({ data: { status: "idle" } });

describe("NoteBacklinks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows API errors instead of an empty connections state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "E_INTERNAL", message: "boom", request_id: "req-1" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connections could not be loaded.",
    );
    expect(screen.queryByText(SCANNABLE_EMPTY_COPY)).not.toBeInTheDocument();
  });

  it("aborts stale reads and renders the latest object's connection", async () => {
    const requests = stubFetchQueue();

    const { rerender } = render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    await waitFor(() => expect(edgeReads(requests)).toHaveLength(1));
    rerender(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_B }} />,
    );

    await waitFor(() => expect(edgeReads(requests)).toHaveLength(2));
    const [readA, readB] = edgeReads(requests);
    expect(readA.init?.signal?.aborted).toBe(true);
    expect(readB.path).toContain(encodeURIComponent(`note_block:${BLOCK_B}`));

    readB.resolve(
      Response.json({
        data: [
          edge({
            id: "edge-new",
            source_ref: `note_block:${BLOCK_B}`,
            target_label: "New page",
          }),
        ],
      }),
    );
    readA.resolve(
      Response.json({
        data: [
          edge({
            id: "edge-old",
            source_ref: `note_block:${BLOCK_A}`,
            target_label: "Old page",
          }),
        ],
      }),
    );

    expect(await screen.findByText("New page")).toBeInTheDocument();
    expect(screen.queryByText("Old page")).not.toBeInTheDocument();
  });

  it("renders the endpoint that is not the viewed object and disables missing ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/synapse/scans")
          ? idleStatusResponse()
          : Response.json({
              data: [
                // Viewed object is the TARGET here, so the SOURCE is the connection.
                edge({
                  id: "edge-incoming",
                  source_ref: "media:44444444-4444-4444-8444-444444444444",
                  source_label: "Citing media",
                  target_ref: `note_block:${BLOCK_A}`,
                  target_missing: false,
                }),
                edge({
                  id: "edge-missing",
                  source_ref: `note_block:${BLOCK_A}`,
                  target_label: "Deleted page",
                  target_missing: true,
                }),
              ],
            }),
      ),
    );

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    expect(await screen.findByText("Citing media")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deleted page/ })).toBeDisabled();
  });

  it("creates a user connection from an object search result and reloads", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    await waitFor(() => expect(edgeReads(requests)).toHaveLength(1));
    edgeReads(requests)[0].resolve(Response.json({ data: [] }));
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Connection target"), "linked");
    const searchRequests = () =>
      requests.filter((request) =>
        request.path.startsWith("/api/object-refs/search"),
      );
    await waitFor(() => expect(searchRequests().length).toBeGreaterThan(0));
    for (const staleSearch of searchRequests().slice(0, -1)) {
      staleSearch.resolve(Response.json({ data: { objects: [] } }));
    }
    searchRequests()[searchRequests().length - 1].resolve(
      Response.json({
        data: {
          objects: [
            {
              objectType: "media",
              objectId: "44444444-4444-4444-8444-444444444444",
              label: "Linked media",
              route: "/media/44444444-4444-4444-8444-444444444444",
            },
          ],
        },
      }),
    );
    await user.click(await screen.findByRole("option", { name: /Linked media/ }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    const edgePosts = () =>
      requests.filter(
        (request) =>
          request.path === "/api/resource-graph/edges" &&
          request.init?.method === "POST",
      );
    await waitFor(() => expect(edgePosts()).toHaveLength(1));
    const postRequest = edgePosts()[0];
    expect(JSON.parse(String(postRequest.init?.body))).toEqual({
      source_ref: `note_block:${BLOCK_A}`,
      target_ref: "media:44444444-4444-4444-8444-444444444444",
      kind: "context",
    });
    postRequest.resolve(
      Response.json({
        data: edge({
          id: "edge-created",
          source_ref: `note_block:${BLOCK_A}`,
          target_ref: "media:44444444-4444-4444-8444-444444444444",
          target_label: "Linked media",
          origin: "user",
        }),
      }),
    );

    await waitFor(() => expect(edgeReads(requests)).toHaveLength(2));
    edgeReads(requests)[1].resolve(
      Response.json({
        data: [
          edge({
            id: "edge-created",
            source_ref: `note_block:${BLOCK_A}`,
            target_ref: "media:44444444-4444-4444-8444-444444444444",
            target_label: "Linked media",
            origin: "user",
          }),
        ],
      }),
    );
    expect(await screen.findByText("Linked media")).toBeInTheDocument();
  });

  it("uploads files as explicit media attachment connections", async () => {
    const user = userEvent.setup();
    const mediaId = "55555555-5555-4555-8555-555555555555";
    const edgeBody: unknown[] = [];
    let loadedAttachment = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("/api/resource-graph/edges?")) {
          return Response.json({
            data: loadedAttachment
              ? [
                  edge({
                    id: "edge-attachment",
                    origin: "user",
                    source_ref: `note_block:${BLOCK_A}`,
                    target_ref: `media:${mediaId}`,
                    target_label: "paper.pdf",
                  }),
                ]
              : [],
          });
        }
        if (path === "/api/media/upload/init") {
          return Response.json({
            data: {
              media_id: mediaId,
              source_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              source_type: "upload",
              source_attempt_status: "pending",
              idempotency_outcome: "created",
              processing_status: "pending",
              ingest_enqueued: false,
              upload_url: "https://uploads.example/paper.pdf",
              expires_at: "2026-01-01T00:00:00Z",
            },
          });
        }
        if (path === "https://uploads.example/paper.pdf" && init?.method === "PUT") {
          return new Response(null, { status: 200 });
        }
        if (path === `/api/media/${mediaId}/ingest`) {
          return Response.json({
            data: {
              media_id: mediaId,
              source_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              source_type: "upload",
              source_attempt_status: "queued",
              idempotency_outcome: "created",
              duplicate: false,
              processing_status: "pending",
              ingest_enqueued: true,
            },
          });
        }
        if (path === "/api/resource-graph/edges" && init?.method === "POST") {
          edgeBody.push(JSON.parse(String(init.body)));
          loadedAttachment = true;
          return Response.json({
            data: edge({
              id: "edge-attachment",
              origin: "user",
              source_ref: `note_block:${BLOCK_A}`,
              target_ref: `media:${mediaId}`,
              target_label: "paper.pdf",
            }),
          });
        }
        return Response.json({ data: {} }, { status: 404 });
      }),
    );

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    // note_block is a scannable ref, so the empty state invites a synapse scan.
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.upload(
      screen.getByLabelText("Attach files"),
      new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
    );

    await waitFor(() => {
      expect(edgeBody).toEqual([
        {
          source_ref: `note_block:${BLOCK_A}`,
          target_ref: `media:${mediaId}`,
          kind: "context",
        },
      ]);
    });
    expect(await screen.findByText("paper.pdf")).toBeInTheDocument();
  });

  it("marks synapse connections with a marker, rationale, and dismiss control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/synapse/scans")
          ? idleStatusResponse()
          : Response.json({
              data: [
                edge({
                  id: "edge-synapse",
                  origin: "synapse",
                  target_label: "Resonant page",
                  snapshot: { title: "Resonant page", excerpt: "Both argue X" },
                }),
                edge({
                  id: "edge-body",
                  origin: "note_body",
                  target_label: "Body link",
                }),
              ],
            }),
      ),
    );

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    expect(await screen.findByText("Both argue X")).toBeInTheDocument();
    expect(screen.getByLabelText("Synapse connection")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss connection to Resonant page" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss connection to Body link" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete connection to Body link" }),
    ).not.toBeInTheDocument();
  });

  it("orders human assertions above synapse proposals, newest first within groups", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/synapse/scans")
          ? idleStatusResponse()
          : Response.json({
              data: [
                // API order deliberately leads with the newest (synapse) edge.
                edge({
                  id: "edge-synapse",
                  origin: "synapse",
                  target_label: "Resonant page",
                  created_at: "2026-06-01T00:00:00Z",
                }),
                edge({
                  id: "edge-user",
                  origin: "user",
                  target_label: "Manual link",
                  created_at: "2026-01-01T00:00:00Z",
                }),
                edge({
                  id: "edge-body",
                  origin: "note_body",
                  target_label: "Body link",
                  created_at: "2026-03-01T00:00:00Z",
                }),
              ],
            }),
      ),
    );

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    const bodyRow = await screen.findByText("Body link");
    const userRow = screen.getByText("Manual link");
    const synapseRow = screen.getByText("Resonant page");
    // Human group sorts newest-first; the newer synapse edge still trails it.
    expect(
      bodyRow.compareDocumentPosition(userRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      userRow.compareDocumentPosition(synapseRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("dismisses a synapse connection and reloads the list", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    await waitFor(() => expect(edgeReads(requests)).toHaveLength(1));
    edgeReads(requests)[0].resolve(
      Response.json({
        data: [
          edge({
            id: "edge-synapse",
            origin: "synapse",
            target_label: "Resonant page",
            snapshot: { title: "Resonant page", excerpt: "Both argue X" },
          }),
        ],
      }),
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Dismiss connection to Resonant page",
      }),
    );
    const dismissPosts = () =>
      requests.filter(
        (request) =>
          request.path === "/api/synapse/edges/edge-synapse/dismiss",
      );
    await waitFor(() => expect(dismissPosts()).toHaveLength(1));
    expect(dismissPosts()[0].init?.method).toBe("POST");
    dismissPosts()[0].resolve(new Response(null, { status: 204 }));

    await waitFor(() => expect(edgeReads(requests)).toHaveLength(2));
    edgeReads(requests)[1].resolve(Response.json({ data: [] }));
    await waitFor(() =>
      expect(screen.queryByText("Resonant page")).not.toBeInTheDocument(),
    );
  });

  it("hides the scan button and keeps the plain empty state for non-scannable refs", async () => {
    // T2: "conversation" is a valid ref scheme but not a synapse scan source.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ data: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NoteBacklinks
        objectRef={{ objectType: "conversation", objectId: CONVERSATION_ID }}
      />,
    );

    expect(await screen.findByText("No connected objects yet.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Find connections" }),
    ).not.toBeInTheDocument();
    // The mount status probe must not fire for non-scannable refs.
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/synapse"),
      ),
    ).toHaveLength(0);
  });

  it("short-circuits without polling when the scan request reports idle", async () => {
    // T3: a disabled engine (or already-terminal scan) answers idle on POST.
    const user = userEvent.setup();
    const mediaId = "55555555-5555-4555-8555-555555555555";
    const requests = stubFetchQueue();

    render(<NoteBacklinks objectRef={{ objectType: "media", objectId: mediaId }} />);
    await waitFor(() => expect(edgeReads(requests)).toHaveLength(1));
    edgeReads(requests)[0].resolve(Response.json({ data: [] }));
    await waitFor(() => expect(scanStatusReads(requests)).toHaveLength(1));
    scanStatusReads(requests)[0].resolve(idleStatusResponse());

    await user.click(
      await screen.findByRole("button", { name: "Find connections" }),
    );
    await waitFor(() => expect(scanPosts(requests)).toHaveLength(1));
    scanPosts(requests)[0].resolve(
      Response.json(
        { data: { queued: false, status: "idle" } },
        { status: 202 },
      ),
    );

    // Settle reloads the list once with no status polling.
    await waitFor(() => expect(edgeReads(requests)).toHaveLength(2));
    edgeReads(requests)[1].resolve(Response.json({ data: [] }));
    expect(await screen.findByText("No new connections found.")).toBeInTheDocument();
    expect(scanStatusReads(requests)).toHaveLength(1); // just the mount probe
    expect(
      screen.getByRole("button", { name: "Find connections" }),
    ).toBeEnabled();
  });

  it(
    "scans for connections, polls until idle, reloads, and reports the find",
    { timeout: 15_000 },
    async () => {
      const user = userEvent.setup();
      const mediaId = "55555555-5555-4555-8555-555555555555";
      const requests = stubFetchQueue();

      render(<NoteBacklinks objectRef={{ objectType: "media", objectId: mediaId }} />);
      await waitFor(() => expect(edgeReads(requests)).toHaveLength(1));
      edgeReads(requests)[0].resolve(Response.json({ data: [] }));
      expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

      // Resolve the mount probe so only the manual scan drives polling below.
      await waitFor(() => expect(scanStatusReads(requests)).toHaveLength(1));
      expect(scanStatusReads(requests)[0].path).toBe(
        `/api/synapse/scans?ref=${encodeURIComponent(`media:${mediaId}`)}`,
      );
      scanStatusReads(requests)[0].resolve(idleStatusResponse());

      await user.click(screen.getByRole("button", { name: "Find connections" }));
      expect(screen.getByText("Scanning…")).toBeInTheDocument();
      await waitFor(() => expect(scanPosts(requests)).toHaveLength(1));
      expect(scanPosts(requests)[0].init?.method).toBe("POST");
      expect(JSON.parse(String(scanPosts(requests)[0].init?.body))).toEqual({
        ref: `media:${mediaId}`,
      });
      scanPosts(requests)[0].resolve(
        Response.json({ data: { queued: true, status: "pending" } }, { status: 202 }),
      );

      // Status polling runs on a real 2s interval (useIntervalPoll), so each
      // poll needs a waitFor window longer than one tick.
      await waitFor(() => expect(scanStatusReads(requests)).toHaveLength(2), {
        timeout: 4000,
      });
      scanStatusReads(requests)[1].resolve(
        Response.json({ data: { status: "running" } }),
      );

      await waitFor(() => expect(scanStatusReads(requests)).toHaveLength(3), {
        timeout: 4000,
      });
      scanStatusReads(requests)[2].resolve(idleStatusResponse());

      // Idle settles the scan and refetches the connections list.
      await waitFor(() => expect(edgeReads(requests)).toHaveLength(2), {
        timeout: 4000,
      });
      edgeReads(requests)[1].resolve(
        Response.json({
          data: [
            edge({
              id: "edge-found",
              origin: "synapse",
              source_ref: `media:${mediaId}`,
              target_label: "Resonant page",
              snapshot: { title: "Resonant page", excerpt: "Both argue X" },
            }),
          ],
        }),
      );
      expect(await screen.findByText("Resonant page")).toBeInTheDocument();
      // T5: the scan voice reports the delta against the pre-scan list.
      expect(await screen.findByText("1 new connection found.")).toBeInTheDocument();

      // T1: the poll stops at idle — no further status reads after a full
      // poll interval has elapsed.
      const settledStatusReads = scanStatusReads(requests).length;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(scanStatusReads(requests)).toHaveLength(settledStatusReads);
    },
  );

  it("deletes user-created connections but not graph-owned ones", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    await waitFor(() => expect(edgeReads(requests)).toHaveLength(1));
    edgeReads(requests)[0].resolve(
      Response.json({
        data: [
          edge({
            id: "edge-user",
            origin: "user",
            target_label: "Manual link",
          }),
          edge({
            id: "edge-body",
            origin: "note_body",
            target_label: "Body link",
          }),
        ],
      }),
    );

    expect(await screen.findByText("Manual link")).toBeInTheDocument();
    expect(screen.getByText("Body link")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete connection to Body link" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Delete connection to Manual link" }),
    );
    const deleteRequests = () =>
      requests.filter(
        (request) =>
          request.path === "/api/resource-graph/edges/edge-user" &&
          request.init?.method === "DELETE",
      );
    await waitFor(() => expect(deleteRequests()).toHaveLength(1));
    deleteRequests()[0].resolve(new Response(null, { status: 204 }));

    await waitFor(() => expect(edgeReads(requests)).toHaveLength(2));
    edgeReads(requests)[1].resolve(Response.json({ data: [] }));
    await waitFor(() =>
      expect(screen.queryByText("Manual link")).not.toBeInTheDocument(),
    );
  });
});
