import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResourceSurfaceSession } from "./useResourceSurfaceSession";
import type { ResourceSurface } from "@/lib/resources/resourceItems";

const PAGE = "page:11111111-1111-4111-8111-111111111111";
const NOTE = "note_block:22222222-2222-4222-8222-222222222222";

function item(ref: string, scheme: string, id: string) {
  return { ref, scheme, id, label: "", summary: "", route: null, activation: { resourceRef: ref, kind: "none" as const, href: null, unresolvedReason: null }, missing: false, capabilities: { userRelation: { userLinkSource: false, userLinkTarget: "none" as const, noteReferenceTarget: false }, sharing: "None" as const, libraryPlacement: "None" as const, attachable: false, chatSubject: "none" as const, readable: "none" as const, inspectable: "none" as const, citableResultType: null, citationOutputSource: false, appSearchScope: false, conversationSearchScope: false, promptRender: "none" as const, expansionPolicy: "none" as const, expandable: false, adjacencySource: true, adjacencyTarget: true }, versionByLane: { title: 1, body: 1, outgoing_edges: 1 } };
}

const initial: ResourceSurface = { source: { item: item(PAGE, "page", PAGE.slice(5)), content: { kind: "page_title", title: "Page" } }, orderedItems: [{ occurrenceId: "edge-1", target: { item: item(NOTE, "note_block", NOTE.slice(11)), content: { kind: "note_body", bodyPmJson: { type: "paragraph" }, bodyText: "" } } }] };
function wire(surface: ResourceSurface) {
  const content = (value: ResourceSurface["source"]["content"]) => value.kind === "note_body" ? { kind: value.kind, body_pm_json: value.bodyPmJson, body_text: value.bodyText } : value;
  return { source: { item: surface.source.item, content: content(surface.source.content) }, ordered_items: surface.orderedItems.map((row) => ({ occurrence_id: row.occurrenceId, target: { item: row.target.item, content: content(row.target.content) } })) };
}
function response(surface: ResourceSurface) { return new Response(JSON.stringify({ data: { surface: wire(surface) } }), { status: 200, headers: { "Content-Type": "application/json" } }); }
function readResponse(surface: ResourceSurface) {
  return dataResponse({ data: wire(surface) });
}
function dataResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function Harness() {
  const session = useResourceSurfaceSession({ sourceRef: PAGE, initialSurface: initial });
  return <>
    <output aria-label="status">{session.status}</output>
    <output aria-label="title">
      {session.surface.source.content.kind === "page_title"
        ? session.surface.source.content.title
        : ""}
    </output>
    <button type="button" onClick={() => {
      session.command({ type: "insert_note", noteId: "33333333-3333-4333-8333-333333333333", position: { kind: "after", occurrenceId: "edge-1" }, bodyPmJson: { type: "paragraph" } });
      session.command({ type: "split_note", occurrenceId: "local:33333333-3333-4333-8333-333333333333", noteId: "44444444-4444-4444-8444-444444444444", leftBodyPmJson: { type: "paragraph" }, rightBodyPmJson: { type: "paragraph" } });
    }}>rapid</button>
    <button type="button" onClick={() => session.updateTitle("Renamed")}>
      rename
    </button>
    <button type="button" onClick={session.retry}>retry</button>
    <button type="button" onClick={() => {
      session.command({
        type: "insert_note",
        noteId: "33333333-3333-4333-8333-333333333333",
        position: { kind: "after", occurrenceId: "edge-1" },
        bodyPmJson: { type: "paragraph" },
      });
    }}>insert</button>
    <button type="button" onClick={() => {
      const noteId = "33333333-3333-4333-8333-333333333333";
      session.command({
        type: "insert_note",
        noteId,
        position: { kind: "after", occurrenceId: "edge-1" },
        bodyPmJson: { type: "paragraph" },
      });
      session.updateBody({
        occurrenceId: `local:${noteId}`,
        bodyPmJson: {
          type: "paragraph",
          content: [{ type: "text", text: "Draft" }],
        },
        bodyText: "Draft",
        flush: true,
      });
    }}>insert and edit</button>
  </>;
}

describe("useResourceSurfaceSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rebases a rapid split from a local occurrence onto the acknowledged insert", async () => {
    const inserted: ResourceSurface = { ...initial, source: { ...initial.source, item: { ...initial.source.item, versionByLane: { title: 1, body: 1, outgoing_edges: 2 } } }, orderedItems: [...initial.orderedItems, { occurrenceId: "edge-2", target: { item: item("note_block:33333333-3333-4333-8333-333333333333", "note_block", "33333333-3333-4333-8333-333333333333"), content: { kind: "note_body", bodyPmJson: { type: "paragraph" }, bodyText: "" } } }] };
    const split: ResourceSurface = { ...inserted, source: { ...inserted.source, item: { ...inserted.source.item, versionByLane: { title: 1, body: 1, outgoing_edges: 3 } } } };
    let requestCount = 0;
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => {
      requestCount += 1;
      return response(requestCount === 1 ? inserted : split);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: "rapid" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { base_versions: Array<{ lane: string; version: number }>; command: { occurrence_id: string } };
    expect(second.command.occurrence_id).toBe("edge-2");
    expect(second.base_versions).toMatchObject([{ lane: "outgoing_edges", version: 2 }, { lane: "body", version: 1 }]);
  });

  it("flushes a dirty title on pagehide and retries the same local draft after failure", async () => {
    const savedItem = {
      ...initial.source.item,
      label: "Renamed",
      versionByLane: { ...initial.source.item.versionByLane, title: 2 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(dataResponse({
        error: { code: "E_INTERNAL", message: "try again" },
      }, 500))
      .mockResolvedValueOnce(dataResponse({ data: { item: savedItem } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "rename" }));
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("failed"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/resource-items/${encodeURIComponent(PAGE)}/title`,
    );

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("clean"),
    );
    expect(screen.getByLabelText("title")).toHaveTextContent("Renamed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.title).toBe("Renamed");
    expect(secondBody.base_versions).toEqual(firstBody.base_versions);
    expect(secondBody.client_mutation_id).toBe(firstBody.client_mutation_id);
  });

  it("keeps an edited optimistic note dirty until insert acknowledgement makes it saveable", async () => {
    const inserted: ResourceSurface = {
      ...initial,
      source: {
        ...initial.source,
        item: {
          ...initial.source.item,
          versionByLane: { title: 1, body: 1, outgoing_edges: 2 },
        },
      },
      orderedItems: [
        ...initial.orderedItems,
        {
          occurrenceId: "edge-2",
          target: {
            item: item(
              "note_block:33333333-3333-4333-8333-333333333333",
              "note_block",
              "33333333-3333-4333-8333-333333333333",
            ),
            content: {
              kind: "note_body",
              bodyPmJson: { type: "paragraph" },
              bodyText: "",
            },
          },
        },
      ],
    };
    const savedNote = {
      ...inserted.orderedItems[1]!.target.item,
      versionByLane: { body: 2, outgoing_edges: 1 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(inserted))
      .mockResolvedValueOnce(
        dataResponse({ data: { item: savedNote, bodyText: "Draft" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "insert and edit" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/resource-items/${encodeURIComponent(savedNote.ref)}/body`,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.body_pm_json).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Draft" }],
    });
    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("clean"),
    );
  });

  it("reloads and rebases a conflicted structural command before retrying", async () => {
    const latest: ResourceSurface = {
      ...initial,
      source: {
        ...initial.source,
        item: {
          ...initial.source.item,
          versionByLane: { title: 1, body: 1, outgoing_edges: 4 },
        },
      },
    };
    const inserted: ResourceSurface = {
      ...latest,
      source: {
        ...latest.source,
        item: {
          ...latest.source.item,
          versionByLane: { title: 1, body: 1, outgoing_edges: 5 },
        },
      },
      orderedItems: [
        ...latest.orderedItems,
        {
          occurrenceId: "edge-2",
          target: {
            item: item(
              "note_block:33333333-3333-4333-8333-333333333333",
              "note_block",
              "33333333-3333-4333-8333-333333333333",
            ),
            content: {
              kind: "note_body",
              bodyPmJson: { type: "paragraph" },
              bodyText: "",
            },
          },
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        dataResponse({
          error: {
            code: "E_RESOURCE_CONFLICT",
            message: "Resource changed",
          },
        }, 409),
      )
      .mockResolvedValueOnce(readResponse(latest))
      .mockResolvedValueOnce(response(inserted));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "insert" }));
    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("failed"),
    );

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("clean"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/resource-items/${encodeURIComponent(PAGE)}/surface`,
    );
    const original = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const retried = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(retried.client_mutation_id).toBe(original.client_mutation_id);
    expect(retried.base_versions).toEqual([
      { ref: PAGE, lane: "outgoing_edges", version: 4 },
    ]);
  });
});
