import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionEndpointOut, ConnectionOut } from "@/lib/resourceGraph/connections";
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
    // Neutral Links read as "undirected" and, like the outgoing case, default
    // their `other` to the far side (`target`) unless a test overrides it —
    // presenters never re-derive `other` from `source`/`target` roles.
    other: overrides.other ?? (merged.direction === "incoming" ? merged.source : merged.target),
  };
}

/** Raw `ResourceTargetOut` (resource kind) wire shape for `targets/search` stubs. */
function rawResourceTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "resource",
    item: {
      ref: `media:${MEDIA_ID}`,
      scheme: "media",
      id: MEDIA_ID,
      label: "Linked media",
      summary: "",
      route: `/media/${MEDIA_ID}`,
      activation: {
        resourceRef: `media:${MEDIA_ID}`,
        kind: "route",
        href: `/media/${MEDIA_ID}`,
        unresolvedReason: null,
      },
      missing: false,
      capabilities: {
        userRelation: { userLinkSource: true, userLinkTarget: "direct", noteReferenceTarget: true },
        attachable: true,
        chatSubject: "label",
        readable: "body",
        inspectable: "none",
        citableResultType: null,
        citationOutputSource: false,
        appSearchScope: false,
        conversationSearchScope: false,
        promptRender: "none",
        expansionPolicy: "none",
        expandable: false,
        adjacencySource: false,
        adjacencyTarget: true,
      },
      versionByLane: {},
    },
    existingLinkId: null,
    ...overrides,
  };
}

function createLinkOut(conn: ConnectionOut) {
  return { created: true, created_source_ref: null, connection: conn };
}

function stanceOut(conn: ConnectionOut) {
  return { connection: conn };
}

const connectionReads = (requests: PendingRequest[]) =>
  requests.filter(
    (request) =>
      request.path === "/api/resource-graph/connections/query" &&
      request.init?.method === "POST",
  );
const targetSearchReads = (requests: PendingRequest[]) =>
  requests.filter((request) => request.path === "/api/resource-items/targets/search");
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
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connections could not be loaded.",
    );
    expect(screen.queryByText(SCANNABLE_EMPTY_COPY)).not.toBeInTheDocument();
  });

  it("aborts stale reads and renders the latest object's connection", async () => {
    const requests = stubFetchQueue();

    const { rerender } = render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));

    rerender(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_B }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));

    const [readA, readB] = connectionReads(requests);
    expect(readA.init?.signal?.aborted).toBe(true);
    expect(JSON.parse(String(readB.init?.body))).toMatchObject({
      refs: [`note_block:${BLOCK_B}`],
      filters: {
        origins: [
          "user",
          "note_body",
          "highlight_note",
          "citation",
          "synapse",
          "document_embed",
        ],
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
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );

    expect(await screen.findByText("Citing media")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deleted page/ })).toBeDisabled();
  });

  it("renders an undirected neutral Link like any other connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/synapse/scans")
          ? idleStatusResponse()
          : connectionResponse([
              connection({
                edge_id: "edge-undirected",
                direction: "undirected",
                origin: "user",
                kind: "context",
                target: endpoint(`page:${PAGE_ID}`, "Neutral link", false, `/pages/${PAGE_ID}`),
              }),
            ]),
      ),
    );

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );

    expect(await screen.findByText("Neutral link")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete connection to Neutral link" }),
    ).toBeInTheDocument();
  });

  it("keeps the connect composer collapsed until the disclosure reveals it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/synapse/scans")
          ? idleStatusResponse()
          : connectionResponse([]),
      ),
    );

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    const disclosure = screen.getByRole("button", { name: /Link/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Connection target")).not.toBeInTheDocument();

    await user.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const field = await screen.findByLabelText("Connection target");
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("creates a Link from a resource target search result and reloads", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));
    connectionReads(requests)[0].resolve(connectionResponse([]));
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Link/ }));
    await user.type(screen.getByLabelText("Connection target"), "linked");
    await waitFor(() => expect(targetSearchReads(requests).length).toBeGreaterThan(0));
    for (const stale of targetSearchReads(requests).slice(0, -1)) {
      stale.resolve(Response.json({ data: { targets: [], nextCursor: null } }));
    }
    targetSearchReads(requests)[targetSearchReads(requests).length - 1].resolve(
      Response.json({ data: { targets: [rawResourceTarget()], nextCursor: null } }),
    );

    await user.click(await screen.findByRole("option", { name: /Linked media/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));

    const linkPosts = () =>
      requests.filter(
        (request) =>
          request.path === "/api/resource-graph/links" && request.init?.method === "POST",
      );
    await waitFor(() => expect(linkPosts()).toHaveLength(1));
    expect(JSON.parse(String(linkPosts()[0].init?.body))).toMatchObject({
      source: { kind: "resource", ref: `note_block:${BLOCK_A}` },
      target: { kind: "resource", ref: `media:${MEDIA_ID}` },
    });
    linkPosts()[0].resolve(
      Response.json({
        data: createLinkOut(
          connection({
            edge_id: "edge-created",
            origin: "user",
            direction: "undirected",
            target_ref: `media:${MEDIA_ID}`,
            target: endpoint(`media:${MEDIA_ID}`, "Linked media", false, `/media/${MEDIA_ID}`),
          }),
        ),
      }),
    );

    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));
    connectionReads(requests)[1].resolve(
      connectionResponse([
        connection({
          edge_id: "edge-created",
          origin: "user",
          direction: "undirected",
          target_ref: `media:${MEDIA_ID}`,
          target: endpoint(`media:${MEDIA_ID}`, "Linked media", false, `/media/${MEDIA_ID}`),
        }),
      ]),
    );
    expect(await screen.findByText("Linked media")).toBeInTheDocument();
  });

  it("records a stance through the stance command, not a Link", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));
    connectionReads(requests)[0].resolve(connectionResponse([]));
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Link/ }));
    await user.selectOptions(screen.getByLabelText("Connection kind"), "supports");
    await user.type(screen.getByLabelText("Connection target"), "linked");
    await waitFor(() => expect(targetSearchReads(requests).length).toBeGreaterThan(0));
    targetSearchReads(requests)[targetSearchReads(requests).length - 1].resolve(
      Response.json({ data: { targets: [rawResourceTarget()], nextCursor: null } }),
    );
    await user.click(await screen.findByRole("option", { name: /Linked media/ }));
    await user.click(screen.getByRole("button", { name: "Record stance" }));

    const stancePuts = () =>
      requests.filter(
        (request) =>
          request.path === "/api/resource-graph/stances" && request.init?.method === "PUT",
      );
    await waitFor(() => expect(stancePuts()).toHaveLength(1));
    expect(JSON.parse(String(stancePuts()[0].init?.body))).toEqual({
      source_ref: `note_block:${BLOCK_A}`,
      target_ref: `media:${MEDIA_ID}`,
      kind: "supports",
    });
    stancePuts()[0].resolve(
      Response.json({
        data: stanceOut(
          connection({
            edge_id: "edge-stance",
            origin: "user",
            kind: "supports",
            target_ref: `media:${MEDIA_ID}`,
            target: endpoint(`media:${MEDIA_ID}`, "Linked media", false, `/media/${MEDIA_ID}`),
          }),
        ),
      }),
    );

    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));

    const linkPosts = requests.filter(
      (request) =>
        request.path === "/api/resource-graph/links" && request.init?.method === "POST",
    );
    expect(linkPosts).toHaveLength(0);
  });

  it("hides passage candidates from the listbox for a stance kind", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));
    connectionReads(requests)[0].resolve(connectionResponse([]));
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Link/ }));
    // A stance (supports) has no passage-materialization path, so the composer
    // must never surface a passage candidate as a selectable stance target.
    await user.selectOptions(screen.getByLabelText("Connection kind"), "supports");
    await user.type(screen.getByLabelText("Connection target"), "ansible");
    await waitFor(() => expect(targetSearchReads(requests).length).toBeGreaterThan(0));
    targetSearchReads(requests)[targetSearchReads(requests).length - 1].resolve(
      Response.json({
        data: {
          targets: [
            rawResourceTarget(),
            {
              kind: "passage",
              candidateRef: `content_chunk:${BLOCK_B}`,
              source: rawResourceTarget().item,
              label: "Chapter 3",
              excerpt: "the ansible hummed",
              activation: {
                resourceRef: `content_chunk:${BLOCK_B}`,
                kind: "none",
                href: null,
                unresolvedReason: null,
              },
              existingLinkId: null,
            },
          ],
          nextCursor: null,
        },
      }),
    );

    expect(await screen.findByRole("option", { name: /Linked media/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Chapter 3/ })).not.toBeInTheDocument();
  });

  it("uploads files then Links the ingested media", async () => {
    const user = userEvent.setup();
    const linkBodies: unknown[] = [];
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
                    direction: "undirected",
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
        if (path === "/api/resource-graph/links" && init?.method === "POST") {
          linkBodies.push(JSON.parse(String(init.body)));
          loadedAttachment = true;
          return Response.json({
            data: createLinkOut(
              connection({
                edge_id: "edge-attachment",
                origin: "user",
                direction: "undirected",
                target_ref: `media:${MEDIA_ID}`,
                target: endpoint(`media:${MEDIA_ID}`, "paper.pdf", false, `/media/${MEDIA_ID}`),
              }),
            ),
          });
        }
        if (path.startsWith("/api/synapse/scans")) return idleStatusResponse();
        return Response.json({ data: {} }, { status: 404 });
      }),
    );

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Link/ }));
    await user.upload(
      screen.getByLabelText("Attach files"),
      new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
    );

    await waitFor(() => {
      expect(linkBodies).toMatchObject([
        {
          source: { kind: "resource", ref: `note_block:${BLOCK_A}` },
          target: { kind: "resource", ref: `media:${MEDIA_ID}` },
        },
      ]);
    });
    expect(await screen.findByText("paper.pdf")).toBeInTheDocument();
  });

  it("keeps ingested media visible with Retry when only the Link write fails", async () => {
    const user = userEvent.setup();
    let linkAttempts = 0;
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
                    direction: "undirected",
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
        if (path === "/api/resource-graph/links" && init?.method === "POST") {
          linkAttempts += 1;
          if (linkAttempts === 1) {
            return new Response(
              JSON.stringify({
                error: { code: "E_INTERNAL", message: "boom", request_id: "req-1" },
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
          loadedAttachment = true;
          return Response.json({
            data: createLinkOut(
              connection({
                edge_id: "edge-attachment",
                origin: "user",
                direction: "undirected",
                target_ref: `media:${MEDIA_ID}`,
                target: endpoint(`media:${MEDIA_ID}`, "paper.pdf", false, `/media/${MEDIA_ID}`),
              }),
            ),
          });
        }
        if (path.startsWith("/api/synapse/scans")) return idleStatusResponse();
        return Response.json({ data: {} }, { status: 404 });
      }),
    );

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    expect(await screen.findByText(SCANNABLE_EMPTY_COPY)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Link/ }));
    await user.upload(
      screen.getByLabelText("Attach files"),
      new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
    );

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("paper.pdf")).toBeInTheDocument();

    await user.click(retry);
    await waitFor(() => expect(linkAttempts).toBe(2));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(),
    );
    // The retried Link succeeded and reloaded; "paper.pdf" now reads as an
    // ordinary connection row, not a pending-attachment row.
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
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );

    // The rationale is set in the machine register inline, stamped with its
    // honest origin (AC-4); the ✦ marker + aria are retained.
    const rationale = await screen.findByText("Both argue X");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the rationale is INSIDE a machine-origin element; that ancestor carries a data-provenance attribute, not a role/label
    expect(rationale.closest("[data-machine-origin]")).toHaveAttribute(
      "data-machine-origin",
      "Synapse",
    );
    expect(screen.getByLabelText("Synapse connection")).toBeInTheDocument();
    // A non-synapse row shows no machine styling.
    const bodyLink = screen.getByText("Body link");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting a user-origin row has NO machine-origin ancestor
    expect(bodyLink.closest("[data-machine-origin]")).toBeNull();
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
        resourceRef={{ scheme: "conversation", id: CONVERSATION_ID }}
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

    render(<ConnectionsSurface resourceRef={{ scheme: "media", id: MEDIA_ID }} />);
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

  it("deletes user-created neutral Links through the Link command", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));
    connectionReads(requests)[0].resolve(
      connectionResponse([
        connection({
          edge_id: "edge-user",
          origin: "user",
          direction: "undirected",
          kind: "context",
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
          request.path === "/api/resource-graph/links/edge-user" &&
          request.init?.method === "DELETE",
      );
    await waitFor(() => expect(deletes()).toHaveLength(1));
    deletes()[0].resolve(new Response(null, { status: 204 }));

    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));
    connectionReads(requests)[1].resolve(connectionResponse([]));
    await waitFor(() => expect(screen.queryByText("Manual link")).not.toBeInTheDocument());
  });

  it("deletes user-created stances through the stance command, not Link", async () => {
    const user = userEvent.setup();
    const requests = stubFetchQueue();

    render(
      <ConnectionsSurface resourceRef={{ scheme: "note_block", id: BLOCK_A }} />,
    );
    await waitFor(() => expect(connectionReads(requests)).toHaveLength(1));
    connectionReads(requests)[0].resolve(
      connectionResponse([
        connection({
          edge_id: "edge-stance",
          origin: "user",
          kind: "supports",
          target: endpoint(`page:${PAGE_ID}`, "Supported page", false, `/pages/${PAGE_ID}`),
        }),
      ]),
    );

    expect(await screen.findByText("Supported page")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Delete connection to Supported page" }),
    );

    const stanceDeletes = () =>
      requests.filter(
        (request) =>
          request.path === "/api/resource-graph/stances/edge-stance" &&
          request.init?.method === "DELETE",
      );
    await waitFor(() => expect(stanceDeletes()).toHaveLength(1));
    stanceDeletes()[0].resolve(new Response(null, { status: 204 }));

    const linkDeletes = requests.filter(
      (request) =>
        request.path.startsWith("/api/resource-graph/links/") &&
        request.init?.method === "DELETE",
    );
    expect(linkDeletes).toHaveLength(0);

    await waitFor(() => expect(connectionReads(requests)).toHaveLength(2));
    connectionReads(requests)[1].resolve(connectionResponse([]));
    await waitFor(() => expect(screen.queryByText("Supported page")).not.toBeInTheDocument());
  });
});
