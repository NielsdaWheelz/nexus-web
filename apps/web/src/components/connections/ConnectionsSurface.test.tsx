import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionEndpointOut, ConnectionOut } from "@/lib/resourceGraph/connections";
import type { EdgeOut } from "@/lib/resourceGraph/edges";
import ConnectionsSurface from "./ConnectionsSurface";

const BLOCK_A = "11111111-1111-4111-8111-111111111111";
const BLOCK_B = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const MEDIA_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";

const SCANNABLE_EMPTY_COPY =
  "No connections yet. Scan to find resonant material, or link one manually.";

interface PendingRequest {
  path: string;
  init?: RequestInit;
  resolve: (response: Response) => void;
}

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

function endpoint(
  ref: string,
  label: string,
  missing = false,
  href: string | null = `/${ref.replace(":", "s/")}`,
): ConnectionEndpointOut {
  const [scheme, id] = ref.split(":") as [ConnectionEndpointOut["scheme"], string];
  return {
    ref,
    scheme,
    id,
    label,
    description: null,
    activation: {
      resourceRef: ref,
      kind: href ? "route" : "none",
      href,
      unresolvedReason: href ? null : "missing",
    },
    href,
    missing,
  };
}

function connection(overrides: Partial<ConnectionOut> = {}): ConnectionOut {
  const source = endpoint(`note_block:${BLOCK_A}`, "This block", false, `/notes/${BLOCK_A}`);
  const target = endpoint(`page:${PAGE_ID}`, "Linked page", false, `/pages/${PAGE_ID}`);
  const merged: ConnectionOut = {
    edge_id: "edge-1",
    direction: "outgoing",
    kind: "context",
    origin: "note_body",
    snapshot: null,
    source_order_key: null,
    target_order_key: null,
    ordinal: null,
    source_ref: source.ref,
    target_ref: target.ref,
    source,
    target,
    other: target,
    citation: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  return {
    ...merged,
    other: overrides.other ?? (merged.direction === "incoming" ? merged.source : merged.target),
  };
}

function createdEdge(): EdgeOut {
  return {
    id: "edge-created",
    kind: "context",
    origin: "user",
    source_ref: `note_block:${BLOCK_A}`,
    target_ref: `media:${MEDIA_ID}`,
    source_order_key: null,
    target_order_key: null,
    ordinal: null,
    snapshot: null,
    source_label: "This block",
    source_missing: false,
    target_label: "Linked media",
    target_missing: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

const connectionReads = (requests: PendingRequest[]) =>
  requests.filter(
    (request) =>
      request.path === "/api/resource-graph/connections/query" &&
      request.init?.method === "POST",
  );
const scanStatusReads = (requests: PendingRequest[]) =>
  requests.filter((request) => request.path.startsWith("/api/synapse/scans?"));
const scanPosts = (requests: PendingRequest[]) =>
  requests.filter((request) => request.path === "/api/synapse/scans");
const connectionResponse = (items: ConnectionOut[]) =>
  Response.json({ data: { items, next_cursor: null } });
const idleStatusResponse = () => Response.json({ data: { status: "idle" } });

describe("ConnectionsSurface", () => {
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
      <ConnectionsSurface objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connections could not be loaded.",
    );
    expect(screen.queryByText(SCANNABLE_EMPTY_COPY)).not.toBeInTheDocument();
  });

  it("aborts stale reads and renders the latest object's connection", async () => {
    const requests = stubFetchQueue();

    const { rerender } = render(
      <ConnectionsSurface objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));

    rerender(
      <ConnectionsSurface objectRef={{ objectType: "note_block", objectId: BLOCK_B }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));

    const [readA, readB] = connectionReads(requests);
    expect(readA.init?.signal?.aborted).toBe(true);
    expect(JSON.parse(String(readB.init?.body))).toMatchObject({
      refs: [`note_block:${BLOCK_B}`],
      filters: {
        origins: ["user", "note_body", "highlight_note", "citation", "synapse"],
        kinds: ["context", "supports", "contradicts"],
      },
    });

    readB.resolve(
      connectionResponse([
        connection({
          edge_id: "edge-new",
          source_ref: `note_block:${BLOCK_B}`,
          source: endpoint(`note_block:${BLOCK_B}`, "New block", false, `/notes/${BLOCK_B}`),
          target: endpoint(`page:${PAGE_ID}`, "New page", false, `/pages/${PAGE_ID}`),
        }),
      ]),
    );
    readA.resolve(
      connectionResponse([
        connection({
          edge_id: "edge-old",
          target: endpoint(`page:${PAGE_ID}`, "Old page", false, `/pages/${PAGE_ID}`),
        }),
      ]),
    );

    expect(await screen.findByText("New page")).toBeInTheDocument();
    expect(screen.queryByText("Old page")).not.toBeInTheDocument();
  });

  it("renders the opposite endpoint and disables missing connections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/synapse/scans")
          ? idleStatusResponse()
          : connectionResponse([
              connection({
                edge_id: "edge-incoming",
                direction: "incoming",
                source_ref: `media:${MEDIA_ID}`,
                target_ref: `note_block:${BLOCK_A}`,
                source: endpoint(`media:${MEDIA_ID}`, "Citing media", false, `/media/${MEDIA_ID}`),
                target: endpoint(`note_block:${BLOCK_A}`, "This block", false, `/notes/${BLOCK_A}`),
              }),
              connection({
                edge_id: "edge-missing",
                target: endpoint(`page:${PAGE_ID}`, "Deleted page", true, null),
              }),
            ]),
      ),
    );

    render(
      <ConnectionsSurface objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    expect(await screen.findByText("Citing media")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deleted page/ })).toBeDisabled();
  });

  it("creates a user connection from an object search result and reloads", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <ConnectionsSurface objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));
    connectionReads(requests)[0].resolve(connectionResponse([]));
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Connection target"), "linked");
    const searchRequests = () =>
      requests.filter((request) => request.path.startsWith("/api/object-refs/search"));
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
              objectId: MEDIA_ID,
              label: "Linked media",
              route: `/media/${MEDIA_ID}`,
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
          request.path === "/api/resource-graph/edges" && request.init?.method === "POST",
      );
    await waitFor(() => expect(edgePosts()).toHaveLength(1));
    expect(JSON.parse(String(edgePosts()[0].init?.body))).toEqual({
      source_ref: `note_block:${BLOCK_A}`,
      target_ref: `media:${MEDIA_ID}`,
      kind: "context",
    });
    edgePosts()[0].resolve(Response.json({ data: createdEdge() }));

    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));
    connectionReads(requests)[1].resolve(
      connectionResponse([
        connection({
          edge_id: "edge-created",
          origin: "user",
          target_ref: `media:${MEDIA_ID}`,
          target: endpoint(`media:${MEDIA_ID}`, "Linked media", false, `/media/${MEDIA_ID}`),
        }),
      ]),
    );
    expect(await screen.findByText("Linked media")).toBeInTheDocument();
  });

  it("uploads files as explicit media attachment connections", async () => {
    const user = userEvent.setup();
    const edgeBodies: unknown[] = [];
    let loadedAttachment = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/resource-graph/connections/query") {
          return connectionResponse(
            loadedAttachment
              ? [
                  connection({
                    edge_id: "edge-attachment",
                    origin: "user",
                    target_ref: `media:${MEDIA_ID}`,
                    target: endpoint(`media:${MEDIA_ID}`, "paper.pdf", false, `/media/${MEDIA_ID}`),
                  }),
                ]
              : [],
          );
        }
        if (path === "/api/media/upload/init") {
          return Response.json({
            data: {
              media_id: MEDIA_ID,
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
        if (path === `/api/media/${MEDIA_ID}/ingest`) {
          return Response.json({
            data: {
              media_id: MEDIA_ID,
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
          edgeBodies.push(JSON.parse(String(init.body)));
          loadedAttachment = true;
          return Response.json({ data: createdEdge() });
        }
        if (path.startsWith("/api/synapse/scans")) return idleStatusResponse();
        return Response.json({ data: {} }, { status: 404 });
      }),
    );

    render(
      <ConnectionsSurface objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.upload(
      screen.getByLabelText("Attach files"),
      new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
    );

    await waitFor(() => {
      expect(edgeBodies).toEqual([
        {
          source_ref: `note_block:${BLOCK_A}`,
          target_ref: `media:${MEDIA_ID}`,
          kind: "context",
        },
      ]);
    });
    expect(await screen.findByText("paper.pdf")).toBeInTheDocument();
  });

  it("marks synapse connections with rationale and dismiss control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/synapse/scans")
          ? idleStatusResponse()
          : connectionResponse([
              connection({
                edge_id: "edge-synapse",
                origin: "synapse",
                snapshot: { title: "Resonant page", excerpt: "Both argue X" },
                target: endpoint(`page:${PAGE_ID}`, "Resonant page", false, `/pages/${PAGE_ID}`),
              }),
              connection({
                edge_id: "edge-body",
                origin: "note_body",
                target: endpoint(`page:${PAGE_ID}`, "Body link", false, `/pages/${PAGE_ID}`),
              }),
            ]),
      ),
    );

    render(
      <ConnectionsSurface objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    expect(await screen.findByText("Both argue X")).toBeInTheDocument();
    expect(screen.getByLabelText("Synapse connection")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss connection to Resonant page" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss connection to Body link" }),
    ).not.toBeInTheDocument();
  });

  it("hides the scan button for non-scannable refs", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => connectionResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConnectionsSurface
        objectRef={{ objectType: "conversation", objectId: CONVERSATION_ID }}
      />,
    );

    expect(await screen.findByText("No connected objects yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find connections" })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/synapse")),
    ).toHaveLength(0);
  });

  it("short-circuits without polling when the scan request reports idle", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(<ConnectionsSurface objectRef={{ objectType: "media", objectId: MEDIA_ID }} />);
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));
    connectionReads(requests)[0].resolve(connectionResponse([]));
    await waitFor(() => expect(scanStatusReads(requests)).toHaveLength(1));
    scanStatusReads(requests)[0].resolve(idleStatusResponse());

    await user.click(await screen.findByRole("button", { name: "Find connections" }));
    await waitFor(() => expect(scanPosts(requests)).toHaveLength(1));
    scanPosts(requests)[0].resolve(
      Response.json({ data: { queued: false, status: "idle" } }, { status: 202 }),
    );

    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));
    connectionReads(requests)[1].resolve(connectionResponse([]));
    expect(await screen.findByText("No new connections found.")).toBeInTheDocument();
    expect(scanStatusReads(requests)).toHaveLength(1);
  });

  it("deletes user-created connections but not graph-owned ones", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <ConnectionsSurface objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));
    connectionReads(requests)[0].resolve(
      connectionResponse([
        connection({
          edge_id: "edge-user",
          origin: "user",
          target: endpoint(`page:${PAGE_ID}`, "Manual link", false, `/pages/${PAGE_ID}`),
        }),
        connection({
          edge_id: "edge-body",
          origin: "note_body",
          target: endpoint(`page:${PAGE_ID}`, "Body link", false, `/pages/${PAGE_ID}`),
        }),
      ]),
    );

    expect(await screen.findByText("Manual link")).toBeInTheDocument();
    expect(screen.getByText("Body link")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete connection to Body link" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete connection to Manual link" }));
    const deletes = () =>
      requests.filter(
        (request) =>
          request.path === "/api/resource-graph/edges/edge-user" &&
          request.init?.method === "DELETE",
      );
    await waitFor(() => expect(deletes()).toHaveLength(1));
    deletes()[0].resolve(new Response(null, { status: 204 }));

    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));
    connectionReads(requests)[1].resolve(connectionResponse([]));
    await waitFor(() => expect(screen.queryByText("Manual link")).not.toBeInTheDocument());
  });
});
