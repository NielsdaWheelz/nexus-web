import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import {
  dailyDraftKey,
  writeDailyDraft,
} from "@/lib/notes/dailyDraftStore";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { PaneEntryDelivery } from "@/lib/workspace/targetActivation";
import PagePaneBody from "./PagePaneBody";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_NOTE_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_NOTE_ID = "33333333-3333-4333-8333-333333333333";
const LOCAL_DATE = "2026-07-30";
const DEFAULT_TITLE = "Thursday, July 30";
const RENAMED_TITLE = "Field Notes";
const PAGE_REF_DELIVERY: PaneEntryDelivery = {
  activationId: "daily-page-ref-activation",
  paneId: "pane",
  visitId: "visit" as never,
  entry: {
    kind: "AppendNote",
    noteId: DRAFT_NOTE_ID,
    clientMutationId: "daily-page-ref-capture",
    initialText: "Captured thought",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function pageItem(title = DEFAULT_TITLE) {
  const ref = `page:${PAGE_ID}`;
  return {
    ref,
    scheme: "page",
    id: PAGE_ID,
    label: title,
    summary: "",
    route: `/pages/${PAGE_ID}`,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/pages/${PAGE_ID}`,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: false,
        userLinkTarget: "none",
        noteReferenceTarget: false,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: { title: 1, outgoing_edges: 1 },
  };
}

function noteItem(noteId: string) {
  const ref = `note_block:${noteId}`;
  return {
    ...pageItem(),
    ref,
    scheme: "note_block",
    id: noteId,
    label: "",
    route: null,
    activation: {
      resourceRef: ref,
      kind: "none",
      href: null,
      unresolvedReason: null,
    },
    versionByLane: { body: 1, outgoing_edges: 1 },
  };
}

function App() {
  return (
    <AuthenticatedAccountProvider
      account={{
        accountId: ACCOUNT_ID,
        calendarTimeZone: "America/Los_Angeles",
      }}
    >
      <PaneReturnMementoProvider>
        <PaneReturnVisitScope visitId={"visit" as never} routeKey="daily">
          <PaneRuntimeProvider
            paneId="pane"
            visitId={"visit" as never}
            isActive
            href={`/daily/${LOCAL_DATE}`}
            routeId="dailyDate"
            pathParams={{ localDate: LOCAL_DATE }}
            canGoBack={false}
            canGoForward={false}
            onNavigatePane={vi.fn()}
            onReplacePane={vi.fn()}
            onActivateWorkspaceTarget={vi.fn(() => ({
              kind: "ActivatedExisting" as const,
              paneId: "pane",
            }))}
            onGoBackPane={vi.fn()}
            onGoForwardPane={vi.fn()}
          >
            <PanePrimaryChromeProvider publish={vi.fn()}>
              <div data-pane-content="true" data-testid="daily-scrollport">
                <PagePaneBody />
              </div>
            </PanePrimaryChromeProvider>
          </PaneRuntimeProvider>
        </PaneReturnVisitScope>
      </PaneReturnMementoProvider>
    </AuthenticatedAccountProvider>
  );
}

function PageRefApp({
  onAcknowledge,
}: {
  onAcknowledge: (delivery: PaneEntryDelivery) => void;
}) {
  return (
    <AuthenticatedAccountProvider
      account={{
        accountId: ACCOUNT_ID,
        calendarTimeZone: "America/Los_Angeles",
      }}
    >
      <PaneReturnMementoProvider>
        <PaneReturnVisitScope visitId={"visit" as never} routeKey="page">
          <PaneRuntimeProvider
            paneId="pane"
            visitId={"visit" as never}
            isActive
            href={`/pages/${PAGE_ID}`}
            routeId="page"
            pathParams={{ pageId: PAGE_ID }}
            paneEntryDelivery={PAGE_REF_DELIVERY}
            canGoBack={false}
            canGoForward={false}
            onNavigatePane={vi.fn()}
            onReplacePane={vi.fn()}
            onActivateWorkspaceTarget={vi.fn(() => ({
              kind: "ActivatedExisting" as const,
              paneId: "pane",
            }))}
            onGoBackPane={vi.fn()}
            onGoForwardPane={vi.fn()}
            onAcknowledgePaneEntryDelivery={onAcknowledge}
          >
            <PanePrimaryChromeProvider publish={vi.fn()}>
              <PagePaneBody
                pageIdOverride={PAGE_ID}
                initialPage={{
                  id: PAGE_ID,
                  title: DEFAULT_TITLE,
                  actionTarget: routeResourceActionSubject({
                    scheme: "page",
                    id: PAGE_ID,
                    href: `/pages/${PAGE_ID}`,
                  }),
                  dailyPage: { localDate: LOCAL_DATE },
                }}
              />
            </PanePrimaryChromeProvider>
          </PaneRuntimeProvider>
        </PaneReturnVisitScope>
      </PaneReturnMementoProvider>
    </AuthenticatedAccountProvider>
  );
}

describe("PagePaneBody daily hydration", () => {
  it("keeps a latent daily view read-only and unfocused until the user adds a note", async () => {
    localStorage.clear();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === `/api/notes/daily/${LOCAL_DATE}`) {
          return Response.json({
            data: {
              kind: "Latent",
              localDate: LOCAL_DATE,
              defaultTitle: DEFAULT_TITLE,
            },
          });
        }
        if (path === "/api/notes/dawn-write") {
          return Response.json({ write: null });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const title = await screen.findByRole("textbox", { name: "Page title" });
    expect(title).not.toHaveFocus();
    expect(screen.queryByRole("textbox", { name: /Edit note/ })).toBeNull();
    expect(
      localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE)),
    ).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const path = new URL(String(input), "http://localhost").pathname;
        return path.endsWith("/captures") && init?.method === "POST";
      }),
    ).toBe(false);
  });

  it("claims a daily append delivery in an already-open PageRef pane and focuses its provisional tail", async () => {
    localStorage.clear();
    const onAcknowledge = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = decodeURIComponent(
        new URL(String(input), "http://localhost").pathname,
      );
      if (path === `/api/resource-items/page:${PAGE_ID}/surface`) {
        return Response.json({
          data: {
            source: {
              item: pageItem(),
              content: { kind: "page_title", title: DEFAULT_TITLE },
            },
            ordered_items: [{
              occurrence_id: "server-row",
              target: {
                item: noteItem(SERVER_NOTE_ID),
                content: {
                  kind: "note_body",
                  body_pm_json: paragraphFromText("Persisted").toJSON(),
                  body_text: "Persisted",
                },
              },
            }],
          },
        });
      }
      if (path === "/api/notes/dawn-write") {
        return Response.json({ write: null });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PageRefApp onAcknowledge={onAcknowledge} />);

    const provisional = await screen.findByRole("textbox", {
      name: "Edit note 2",
    });
    await waitFor(() => expect(provisional).toHaveFocus());
    expect(onAcknowledge).toHaveBeenCalledOnce();
    expect(onAcknowledge).toHaveBeenCalledWith(PAGE_REF_DELIVERY);
    expect(
      JSON.parse(
        localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE)) ?? "{}",
      ),
    ).toMatchObject({
      noteId: DRAFT_NOTE_ID,
      clientMutationId: "daily-page-ref-capture",
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(`/api/notes/daily/${LOCAL_DATE}`),
      ),
    ).toBe(false);
  });

  it("keeps text typed into a provisional note before the descriptor appears", async () => {
    localStorage.clear();
    const descriptor = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === `/api/notes/daily/${LOCAL_DATE}`) {
          return descriptor.promise;
        }
        if (path === "/api/notes/dawn-write") {
          return Response.json({ write: null });
        }
        if (
          path === `/api/notes/daily/${LOCAL_DATE}/captures` &&
          init?.method === "POST"
        ) {
          const request = JSON.parse(String(init.body)) as {
            noteId: string;
            clientMutationId: string;
            bodyPmJson: Record<string, unknown>;
          };
          return Response.json({
            data: {
              clientMutationId: request.clientMutationId,
              localDate: LOCAL_DATE,
              pageId: PAGE_ID,
              surface: {
                source: {
                  item: pageItem(),
                  content: { kind: "page_title", title: DEFAULT_TITLE },
                },
                ordered_items: [],
              },
            },
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    render(<App />);

    expect(
      localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE)),
    ).toBeNull();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a note" }),
    );
    const editor = await screen.findByRole("textbox", { name: "Edit note 1" });
    await userEvent.type(editor, "Before hydration");
    expect(screen.queryByRole("textbox", { name: "Page title" })).toBeNull();

    descriptor.resolve(
      Response.json({
        data: {
          kind: "Latent",
          localDate: LOCAL_DATE,
          defaultTitle: DEFAULT_TITLE,
        },
      }),
    );

    expect(
      await screen.findByRole("textbox", { name: "Page title" }),
    ).toHaveValue(DEFAULT_TITLE);
    expect(screen.getByRole("textbox", { name: "Edit note 1" })).toBe(editor);
    expect(editor).toHaveTextContent("Before hydration");
    expect(
      JSON.parse(
        localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE)) ?? "{}",
      ),
    ).toMatchObject({ bodyText: "Before hydration" });
  });

  it("keeps one focused editor and the latest body while a stale capture acknowledgement materializes it", async () => {
    localStorage.clear();
    const captureResponse = deferred<Response>();
    const patchResponse = deferred<Response>();
    const captureRequests: Array<{
      clientMutationId: string;
      noteId: string;
      bodyPmJson: Record<string, unknown>;
    }> = [];
    const patchRequests: Array<{
      body_pm_json: Record<string, unknown>;
    }> = [];
    let descriptorReads = 0;
    let serverBodyPmJson = paragraphFromText("").toJSON();
    let serverBodyText = "";
    let capturedNoteId: string | null = null;

    const surface = (
      noteId: string,
      bodyPmJson: Record<string, unknown>,
      bodyText: string,
      bodyVersion: number,
    ) => ({
      source: {
        item: pageItem(),
        content: { kind: "page_title", title: DEFAULT_TITLE },
      },
      ordered_items: [{
        occurrence_id: "daily-note-row",
        target: {
          item: {
            ...noteItem(noteId),
            versionByLane: { body: bodyVersion, outgoing_edges: 1 },
          },
          content: {
            kind: "note_body",
            body_pm_json: bodyPmJson,
            body_text: bodyText,
          },
        },
      }],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = decodeURIComponent(
          new URL(String(input), "http://localhost").pathname,
        );
        if (path === `/api/notes/daily/${LOCAL_DATE}`) {
          descriptorReads += 1;
          if (descriptorReads === 1) {
            return Response.json({
              data: {
                kind: "Latent",
                localDate: LOCAL_DATE,
                defaultTitle: DEFAULT_TITLE,
              },
            });
          }
          if (!capturedNoteId) {
            throw new Error("Daily page was re-read before capture");
          }
          return Response.json({
            data: {
              kind: "Materialized",
              localDate: LOCAL_DATE,
              page: {
                id: PAGE_ID,
                title: DEFAULT_TITLE,
                updatedAt: null,
                dailyPage: { localDate: LOCAL_DATE },
              },
              surface: surface(
                capturedNoteId,
                serverBodyPmJson,
                serverBodyText,
                2,
              ),
            },
          });
        }
        if (path === "/api/notes/dawn-write") {
          return Response.json({ write: null });
        }
        if (
          path === `/api/notes/daily/${LOCAL_DATE}/captures` &&
          init?.method === "POST"
        ) {
          const request = JSON.parse(String(init.body)) as {
            clientMutationId: string;
            noteId: string;
            bodyPmJson: Record<string, unknown>;
          };
          captureRequests.push(request);
          capturedNoteId = request.noteId;
          return captureResponse.promise;
        }
        if (
          capturedNoteId &&
          path === `/api/resource-items/note_block:${capturedNoteId}/body` &&
          init?.method === "PATCH"
        ) {
          patchRequests.push(
            JSON.parse(String(init.body)) as {
              body_pm_json: Record<string, unknown>;
            },
          );
          return patchResponse.promise;
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
      }),
    );

    const view = render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a note" }),
    );
    const editor = await screen.findByRole("textbox", { name: "Edit note 1" });
    await userEvent.type(editor, "A");

    await waitFor(() => expect(captureRequests).toHaveLength(1), {
      timeout: 3_000,
    });
    const captureRequest = captureRequests[0]!;
    expect(captureRequest.bodyPmJson).toEqual(paragraphFromText("A").toJSON());
    expect(editor).toHaveFocus();
    await userEvent.type(editor, "B");
    expect(editor).toHaveTextContent(/^AB$/);
    expect(editor).toHaveFocus();

    captureResponse.resolve(
      Response.json({
        data: {
          clientMutationId: captureRequest.clientMutationId,
          localDate: LOCAL_DATE,
          pageId: PAGE_ID,
          surface: surface(
            captureRequest.noteId,
            captureRequest.bodyPmJson,
            "A",
            1,
          ),
        },
      }),
    );

    await waitFor(() => expect(patchRequests).toHaveLength(1));
    expect(patchRequests[0]!.body_pm_json).toEqual(
      paragraphFromText("AB").toJSON(),
    );
    expect(screen.getByRole("textbox", { name: "Edit note 1" })).toBe(editor);
    expect(editor).toHaveTextContent(/^AB$/);
    expect(editor).toHaveFocus();

    serverBodyPmJson = patchRequests[0]!.body_pm_json;
    serverBodyText = "AB";
    patchResponse.resolve(
      Response.json({
        data: {
          item: {
            ...noteItem(captureRequest.noteId),
            versionByLane: { body: 2, outgoing_edges: 1 },
          },
          bodyText: serverBodyText,
        },
      }),
    );
    await waitFor(() =>
      expect(
        localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE)),
      ).toBeNull(),
    );
    expect(screen.getByRole("textbox", { name: "Edit note 1" })).toBe(editor);
    expect(editor).toHaveTextContent(/^AB$/);
    expect(editor).toHaveFocus();

    view.unmount();
    render(<App />);

    const rereadEditors = await screen.findAllByRole("textbox", {
      name: /Edit note/,
    });
    expect(descriptorReads).toBe(2);
    expect(rereadEditors).toHaveLength(1);
    expect(rereadEditors[0]).toHaveTextContent(/^AB$/);
    expect(captureRequests).toHaveLength(1);
    expect(patchRequests).toHaveLength(1);
  });

  it("reveals a renamed materialized title and prepends rows without replacing an actively composing draft editor or moving its caret and scroll anchor", async () => {
    localStorage.clear();
    writeDailyDraft({
      version: 1,
      accountId: ACCOUNT_ID,
      localDate: LOCAL_DATE,
      noteId: DRAFT_NOTE_ID,
      clientMutationId: "capture-prepend",
      bodyPmJson: paragraphFromText("Draft tail").toJSON(),
      bodyText: "Draft tail",
      handoff: { kind: "None" },
    });
    const descriptor = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === `/api/notes/daily/${LOCAL_DATE}`) {
          return descriptor.promise;
        }
        if (path === "/api/notes/dawn-write") {
          return Response.json({ write: null });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    render(<App />);

    const editor = await screen.findByRole("textbox", { name: "Edit note 1" });
    await userEvent.click(editor);
    await userEvent.keyboard("{End}");
    const selectionOffset = window.getSelection()?.anchorOffset;
    let compositionEnded = 0;
    editor.addEventListener("compositionend", () => {
      compositionEnded += 1;
    });
    fireEvent.compositionStart(editor, { data: "入" });
    expect(screen.queryByRole("textbox", { name: "Page title" })).toBeNull();
    expect(screen.queryByText(DEFAULT_TITLE, { exact: true })).toBeNull();
    const draftRow = screen.getAllByRole("listitem")[0]!;
    expect(draftRow).toHaveAttribute(
      "data-note-ref",
      `note_block:${DRAFT_NOTE_ID}`,
    );
    let draftRectReads = 0;
    draftRow.getBoundingClientRect = () => {
      draftRectReads += 1;
      return new DOMRect(0, draftRectReads === 1 ? 200 : 320, 200, 40);
    };
    const scrollport = screen.getByTestId("daily-scrollport");
    scrollport.style.overflowY = "auto";
    Object.defineProperties(scrollport, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    let scrollTop = 40;
    Object.defineProperty(scrollport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next;
      },
    });

    descriptor.resolve(
      Response.json({
        data: {
          kind: "Materialized",
          localDate: LOCAL_DATE,
          page: {
            id: PAGE_ID,
            title: RENAMED_TITLE,
            updatedAt: null,
            dailyPage: { localDate: LOCAL_DATE },
          },
          surface: {
            source: {
              item: {
                ...pageItem(RENAMED_TITLE),
                versionByLane: { title: 1, outgoing_edges: 2 },
              },
              content: { kind: "page_title", title: RENAMED_TITLE },
            },
            ordered_items: [
              {
                occurrence_id: "server-row",
                target: {
                  item: noteItem(SERVER_NOTE_ID),
                  content: {
                    kind: "note_body",
                    body_pm_json: paragraphFromText("Server row").toJSON(),
                    body_text: "Server row",
                  },
                },
              },
            ],
          },
        },
      }),
    );

    await screen.findByText("Server row");
    expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue(
      RENAMED_TITLE,
    );
    const editors = screen.getAllByRole("textbox", { name: /Edit note/ });
    expect(editors.at(-1)).toBe(editor);
    expect(editor).toHaveFocus();
    expect(window.getSelection()?.anchorOffset).toBe(selectionOffset);
    expect(editor).toHaveTextContent("Draft tail");
    fireEvent.compositionEnd(editor, { data: "入" });
    expect(compositionEnded).toBe(1);
    expect(draftRectReads).toBe(2);
    await waitFor(() => expect(scrollport.scrollTop).toBe(160));
  });

  it("keeps a cleared whitespace-only latent note local without capture", async () => {
    localStorage.clear();
    let capturePosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === `/api/notes/daily/${LOCAL_DATE}`) {
          return Response.json({
            data: {
              kind: "Latent",
              localDate: LOCAL_DATE,
              defaultTitle: DEFAULT_TITLE,
            },
          });
        }
        if (path === "/api/notes/dawn-write") {
          return Response.json({ write: null });
        }
        if (
          path === `/api/notes/daily/${LOCAL_DATE}/captures` &&
          init?.method === "POST"
        ) {
          capturePosts += 1;
          throw new Error("Whitespace-only daily notes must not be captured");
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    render(<App />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Add a note" }),
    );
    const editor = await screen.findByRole("textbox", { name: "Edit note 1" });
    await userEvent.type(editor, "   ");
    await userEvent.keyboard("{Control>}a{/Control}{Backspace}");
    await userEvent.click(
      screen.getByRole("textbox", { name: "Page title" }),
    );

    await waitFor(() =>
      expect(
        JSON.parse(
          localStorage.getItem(dailyDraftKey(ACCOUNT_ID, LOCAL_DATE)) ?? "{}",
        ),
      ).toMatchObject({ bodyText: "" }),
    );
    expect(capturePosts).toBe(0);
  });
});
