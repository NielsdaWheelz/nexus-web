import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResourceSurfaceSession } from "./useResourceSurfaceSession";
import type {
  ResourceItem,
  ResourceSurface,
} from "@/lib/resources/resourceItems";
import {
  dailyDraftKey,
  writeDailyDraft,
} from "@/lib/notes/dailyDraftStore";

const PAGE = "page:11111111-1111-4111-8111-111111111111";
const NOTE = "note_block:22222222-2222-4222-8222-222222222222";
const SECOND_NOTE = "note_block:33333333-3333-4333-8333-333333333333";
const LOCAL_DATE = "2026-07-30";
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOURCE_DRAFT_KEY = `nexus.resourceSurface:${PAGE}`;

function item(
  ref: string,
  scheme: ResourceItem["scheme"],
  id: string,
): ResourceItem {
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

function noteBody(text: string) {
  return {
    bodyPmJson: {
      type: "paragraph",
      ...(text ? { content: [{ type: "text", text }] } : {}),
    },
    bodyText: text,
  };
}

function dailyDescriptor(surface: ResourceSurface) {
  return dataResponse({
    data: {
      kind: "Materialized",
      localDate: LOCAL_DATE,
      page: {
        id: PAGE.slice(5),
        title: "Thursday, July 30",
        updatedAt: "2026-07-30T12:00:00Z",
        dailyPage: { localDate: LOCAL_DATE },
      },
      surface: wire(surface),
    },
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

function DailyHarness() {
  const session = useResourceSurfaceSession({
    sessionKey: `daily:${ACCOUNT_ID}:${LOCAL_DATE}`,
    daily: { accountId: ACCOUNT_ID, localDate: LOCAL_DATE },
  });
  const note =
    session.provisional ??
    session.surface?.orderedItems.find((row) => row.target.item.ref === NOTE);
  const occurrenceId =
    session.provisional?.occurrenceId ??
    session.surface?.orderedItems.find((row) => row.target.item.ref === NOTE)
      ?.occurrenceId;
  const bodyText = session.provisional?.bodyText ?? (
    note && "target" in note && note.target.content.kind === "note_body"
      ? note.target.content.bodyText
      : ""
  );
  const noteCount =
    (session.surface?.orderedItems.filter(
      (row) => row.target.item.ref === NOTE,
    ).length ?? 0) + (session.provisional?.noteRef === NOTE ? 1 : 0);
  const update = (text: string) => {
    if (!occurrenceId) return;
    session.updateBody({ occurrenceId, ...noteBody(text), flush: true });
  };
  return <>
    <output aria-label="daily status">{session.status}</output>
    <output aria-label="daily title">{session.title}</output>
    <output aria-label="daily body">{bodyText}</output>
    <output aria-label="daily note count">{noteCount}</output>
    <output aria-label="daily second note">
      {session.surface?.orderedItems.some(
        (row) => row.target.item.ref === SECOND_NOTE,
      )
        ? "present"
        : "absent"}
    </output>
    <button type="button" onClick={() => session.command({
      type: "insert_note",
      noteId: NOTE.slice(11),
      position: { kind: "start" },
      bodyPmJson: noteBody("").bodyPmJson,
    })}>daily add</button>
    <button type="button" onClick={() => {
      session.command({
        type: "insert_note",
        noteId: NOTE.slice(11),
        position: { kind: "start" },
        bodyPmJson: noteBody("").bodyPmJson,
      });
      session.updateBody({
        occurrenceId: `daily-provisional:${NOTE.slice(11)}`,
        ...noteBody("A"),
        flush: true,
      });
    }}>daily start A</button>
    <button type="button" onClick={() => update("A")}>daily A</button>
    <button type="button" onClick={() => update("AB")}>daily append B</button>
    <button type="button" onClick={() => {
      if (!occurrenceId) return;
      session.updateTitle("Recovered title");
      session.updateBody({
        occurrenceId,
        ...noteBody("Recovered body"),
      });
      session.command({
        type: "insert_note",
        noteId: SECOND_NOTE.slice(11),
        position: { kind: "after", occurrenceId },
        bodyPmJson: noteBody("Second").bodyPmJson,
      });
    }}>daily ordinary edits</button>
    <button type="button" onClick={() => {
      const bodyPmJson = {
        type: "paragraph",
        content: [{
          type: "object_ref",
          attrs: {
            objectType: "page",
            objectId: PAGE.slice(5),
            label: "",
          },
        }],
      };
      session.command({
        type: "insert_note",
        noteId: NOTE.slice(11),
        position: { kind: "start" },
        bodyPmJson,
      });
      session.updateBody({
        occurrenceId: `daily-provisional:${NOTE.slice(11)}`,
        bodyPmJson,
        bodyText: "",
        flush: true,
      });
    }}>daily object reference</button>
    <button type="button" onClick={() => {
      const bodyPmJson = {
        type: "paragraph",
        content: [{
          type: "image",
          attrs: { src: "blob:image", alt: "  ", title: null },
        }],
      };
      session.command({
        type: "insert_note",
        noteId: NOTE.slice(11),
        position: { kind: "start" },
        bodyPmJson,
      });
      session.updateBody({
        occurrenceId: `daily-provisional:${NOTE.slice(11)}`,
        bodyPmJson,
        bodyText: "",
        flush: true,
      });
    }}>daily empty-alt image</button>
    <button type="button" onClick={session.retry}>daily retry</button>
    <button type="button" onClick={() => void session.reload()}>daily reload</button>
    <button type="button" onClick={() => void session.copyRecovery()}>daily copy</button>
  </>;
}

function DeliveredDailyHarness() {
  const session = useResourceSurfaceSession({
    sessionKey: `daily:${ACCOUNT_ID}:${LOCAL_DATE}`,
    daily: { accountId: ACCOUNT_ID, localDate: LOCAL_DATE },
    delivery: {
      activationId: "activation-1",
      paneId: "pane-1",
      visitId: "visit-1",
      entry: {
        kind: "AppendNote",
        noteId: NOTE.slice("note_block:".length),
        clientMutationId: "delivery-mutation-1",
        initialText: "Project Ideas",
      },
    },
  });
  return <output aria-label="delivered daily body">{session.provisional?.bodyText}</output>;
}

describe("useResourceSurfaceSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("installs the exact AppendNote seed through the daily draft owner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        dataResponse({
          data: {
            kind: "Latent",
            localDate: LOCAL_DATE,
            defaultTitle: "Thursday, July 30",
          },
        }),
      ),
    );

    render(<DeliveredDailyHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("delivered daily body")).toHaveTextContent(
        "Project Ideas",
      ),
    );
    const stored = JSON.parse(
      window.localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE)) ?? "null",
    ) as { bodyText?: string; noteId?: string; clientMutationId?: string } | null;
    expect(stored).toMatchObject({
      bodyText: "Project Ideas",
      noteId: NOTE.slice("note_block:".length),
      clientMutationId: "delivery-mutation-1",
    });
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

  it("recovers a disconnected latent first capture and sends it only after explicit Retry", async () => {
    const capturedSurface: ResourceSurface = {
      ...initial,
      orderedItems: [{
        ...initial.orderedItems[0]!,
        target: {
          ...initial.orderedItems[0]!.target,
          content: { kind: "note_body", ...noteBody("A") },
        },
      }],
    };
    const captureRequests: Array<Record<string, unknown>> = [];
    let captureAttempts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === `/api/notes/daily/${LOCAL_DATE}`) {
          return dataResponse({
            data: {
              kind: "Latent",
              localDate: LOCAL_DATE,
              defaultTitle: "Thursday, July 30",
            },
          });
        }
        if (path === `/api/notes/daily/${LOCAL_DATE}/captures`) {
          captureAttempts += 1;
          const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
          captureRequests.push(request);
          if (captureAttempts === 1) {
            return dataResponse({
              error: { code: "E_INTERNAL", message: "disconnected" },
            }, 500);
          }
          return dataResponse({
            data: {
              clientMutationId: request.clientMutationId,
              localDate: LOCAL_DATE,
              pageId: PAGE.slice(5),
              surface: wire(capturedSurface),
            },
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<DailyHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("daily title")).toHaveTextContent("Thursday"),
    );
    fireEvent.click(screen.getByRole("button", { name: "daily start A" }));
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("failed"),
    );
    expect(captureAttempts).toBe(1);
    expect(
      JSON.parse(
        localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE)) ?? "null",
      ),
    ).toMatchObject(noteBody("A"));

    view.unmount();
    render(<DailyHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("recovered"),
    );
    expect(screen.getByLabelText("daily body")).toHaveTextContent("A");
    expect(screen.getByLabelText("daily note count")).toHaveTextContent("1");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(captureAttempts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "daily retry" }));
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("clean"),
    );
    expect(captureAttempts).toBe(2);
    expect(captureRequests[1]).toEqual(captureRequests[0]);
    expect(screen.getByLabelText("daily body")).toHaveTextContent("A");
    expect(screen.getByLabelText("daily note count")).toHaveTextContent("1");
    expect(localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE))).toBeNull();
  });

  it("reload discards the recovered daily draft before re-reading the owner", async () => {
    writeDailyDraft({
      version: 1,
      accountId: ACCOUNT_ID,
      localDate: LOCAL_DATE,
      noteId: NOTE.slice(11),
      clientMutationId: "discard-daily",
      ...noteBody("Recovered"),
      handoff: { kind: "None" },
    });
    const serverSurface: ResourceSurface = {
      ...initial,
      orderedItems: [{
        ...initial.orderedItems[0]!,
        target: {
          ...initial.orderedItems[0]!.target,
          content: { kind: "note_body", ...noteBody("Server") },
        },
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(dailyDescriptor(serverSurface))
      .mockResolvedValueOnce(dailyDescriptor(serverSurface));
    vi.stubGlobal("fetch", fetchMock);
    render(<DailyHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("daily body")).toHaveTextContent("Recovered"),
    );
    fireEvent.click(screen.getByRole("button", { name: "daily reload" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText("daily body")).toHaveTextContent("Server"),
    );
    expect(screen.getByLabelText("daily status")).toHaveTextContent("clean");
    expect(localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE))).toBeNull();
  });

  it("recovers and can copy or discard ordinary materialized daily Page edits", async () => {
    const never = new Promise<Response>(() => undefined);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === `/api/notes/daily/${LOCAL_DATE}`) {
          return dailyDescriptor(initial);
        }
        if (path.startsWith("/api/resource-items/")) {
          return never;
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    );
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<DailyHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("daily title")).toHaveTextContent("Page"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "daily ordinary edits" }),
    );
    await waitFor(() =>
      expect(localStorage.getItem(RESOURCE_DRAFT_KEY)).not.toBeNull(),
    );
    view.unmount();

    render(<DailyHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("recovered"),
    );
    expect(screen.getByLabelText("daily title")).toHaveTextContent(
      "Recovered title",
    );
    expect(screen.getByLabelText("daily body")).toHaveTextContent(
      "Recovered body",
    );
    expect(screen.getByLabelText("daily second note")).toHaveTextContent(
      "present",
    );

    fireEvent.click(screen.getByRole("button", { name: "daily copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("Recovered title");
    expect(writeText.mock.calls[0]?.[0]).toContain("Recovered body");
    expect(writeText.mock.calls[0]?.[0]).toContain(SECOND_NOTE.slice(11));

    fireEvent.click(screen.getByRole("button", { name: "daily reload" }));
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("clean"),
    );
    expect(screen.getByLabelText("daily title")).toHaveTextContent("Page");
    expect(screen.getByLabelText("daily body")).toBeEmptyDOMElement();
    expect(screen.getByLabelText("daily second note")).toHaveTextContent(
      "absent",
    );
    expect(localStorage.getItem(RESOURCE_DRAFT_KEY)).toBeNull();
  });

  it("re-reads a failed daily descriptor when Retry has no draft to save", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(dataResponse({
        error: { code: "E_INTERNAL", message: "read failed" },
      }, 500))
      .mockResolvedValueOnce(dataResponse({
        data: {
          kind: "Latent",
          localDate: LOCAL_DATE,
          defaultTitle: "Thursday, July 30",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DailyHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("failed"),
    );
    expect(localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE))).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "daily retry" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("clean"),
    );
    expect(screen.getByLabelText("daily title")).toHaveTextContent(
      "Thursday, July 30",
    );
  });

  it("captures an atomic object reference using the server projection fallback", async () => {
    const capturedSurface: ResourceSurface = {
      ...initial,
      orderedItems: [{
        ...initial.orderedItems[0]!,
        target: {
          ...initial.orderedItems[0]!.target,
          content: {
            kind: "note_body",
            bodyPmJson: {
              type: "paragraph",
              content: [{
                type: "object_ref",
                attrs: {
                  objectType: "page",
                  objectId: PAGE.slice(5),
                  label: "",
                },
              }],
            },
            bodyText: `page:${PAGE.slice(5)}`,
          },
        },
      }],
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === `/api/notes/daily/${LOCAL_DATE}`) {
          return dataResponse({
            data: {
              kind: "Latent",
              localDate: LOCAL_DATE,
              defaultTitle: "Thursday, July 30",
            },
          });
        }
        if (
          path === `/api/notes/daily/${LOCAL_DATE}/captures` &&
          init?.method === "POST"
        ) {
          const request = JSON.parse(String(init.body)) as {
            clientMutationId: string;
          };
          return dataResponse({
            data: {
              clientMutationId: request.clientMutationId,
              localDate: LOCAL_DATE,
              pageId: PAGE.slice(5),
              surface: wire(capturedSurface),
            },
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DailyHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("daily title")).toHaveTextContent("Thursday"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "daily object reference" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as { bodyPmJson: Record<string, unknown> };
    expect(request.bodyPmJson).toMatchObject({
      content: [{
        type: "object_ref",
        attrs: { objectType: "page", objectId: PAGE.slice(5), label: "" },
      }],
    });
  });

  it("does not capture an image whose server projection has only blank alt text", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/notes/daily/${LOCAL_DATE}`) {
        return dataResponse({
          data: {
            kind: "Latent",
            localDate: LOCAL_DATE,
            defaultTitle: "Thursday, July 30",
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DailyHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("daily title")).toHaveTextContent("Thursday"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "daily empty-alt image" }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("dirty"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers post-send typing over capture acknowledgement and reloads A+B once", async () => {
    let resolveCapture!: (response: Response) => void;
    const capture = new Promise<Response>((resolve) => {
      resolveCapture = resolve;
    });
    const capturedSurface: ResourceSurface = {
      ...initial,
      orderedItems: [{
        ...initial.orderedItems[0]!,
        target: {
          ...initial.orderedItems[0]!.target,
          content: { kind: "note_body", ...noteBody("A") },
        },
      }],
    };
    const finalSurface: ResourceSurface = {
      ...capturedSurface,
      orderedItems: [{
        ...capturedSurface.orderedItems[0]!,
        target: {
          ...capturedSurface.orderedItems[0]!.target,
          item: {
            ...capturedSurface.orderedItems[0]!.target.item,
            versionByLane: { body: 2, outgoing_edges: 1 },
          },
          content: { kind: "note_body", ...noteBody("AB") },
        },
      }],
    };
    let descriptor: "latent" | "captured" | "final" = "latent";
    let patchAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/notes/daily/${LOCAL_DATE}`) {
        if (descriptor === "captured") return dailyDescriptor(capturedSurface);
        if (descriptor === "final") return dailyDescriptor(finalSurface);
        return dataResponse({ data: {
          kind: "Latent",
          localDate: LOCAL_DATE,
          defaultTitle: "Thursday, July 30",
        } });
      }
      if (path === `/api/notes/daily/${LOCAL_DATE}/captures`) return capture;
      if (
        path === `/api/resource-items/${encodeURIComponent(NOTE)}/body` &&
        init?.method === "PATCH"
      ) {
        patchAttempts += 1;
        if (patchAttempts === 1) {
          return dataResponse({
            error: { code: "E_INTERNAL", message: "disconnected" },
          }, 500);
        }
        descriptor = "final";
        return dataResponse({
          data: {
            item: finalSurface.orderedItems[0]!.target.item,
            bodyText: "AB",
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<DailyHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("daily title")).toHaveTextContent("Thursday"),
    );
    fireEvent.click(screen.getByRole("button", { name: "daily start A" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "daily append B" }));
    const captureRequest = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as {
      clientMutationId: string;
      noteId: string;
      bodyPmJson: Record<string, unknown>;
    };
    expect(captureRequest).toMatchObject({
      noteId: NOTE.slice(11),
      bodyPmJson: noteBody("A").bodyPmJson,
    });
    resolveCapture(dataResponse({
      data: {
        clientMutationId: captureRequest.clientMutationId,
        localDate: LOCAL_DATE,
        pageId: PAGE.slice(5),
        surface: wire(capturedSurface),
      },
    }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const patch = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(patch.body_pm_json).toEqual(noteBody("AB").bodyPmJson);
    expect(screen.getByLabelText("daily body")).toHaveTextContent("AB");
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("failed"),
    );
    expect(localStorage.getItem(RESOURCE_DRAFT_KEY)).not.toBeNull();

    descriptor = "captured";
    view.unmount();
    const { unmount } = render(<DailyHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("recovered"),
    );
    expect(screen.getByLabelText("daily body")).toHaveTextContent("AB");
    expect(screen.getByLabelText("daily note count")).toHaveTextContent("1");
    expect(patchAttempts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "daily retry" }));
    await waitFor(() =>
      expect(screen.getByLabelText("daily status")).toHaveTextContent("clean"),
    );
    expect(patchAttempts).toBe(2);
    expect(localStorage.getItem(RESOURCE_DRAFT_KEY)).toBeNull();

    unmount();
    render(<DailyHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("daily body")).toHaveTextContent("AB"),
    );
    expect(screen.getByLabelText("daily status")).toHaveTextContent("clean");
    expect(screen.getByLabelText("daily note count")).toHaveTextContent("1");
  });
});
