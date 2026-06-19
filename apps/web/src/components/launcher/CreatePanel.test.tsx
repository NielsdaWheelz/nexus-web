/**
 * CreatePanel — focused component tests (real Chromium, real providers, fetch boundary
 * stubbed). Recovers the quick-note behavior that lived in the deleted
 * `__tests__/components/AddContentTray.test.tsx` after the universal-launcher cutover
 * moved the quick-note editor into `CreatePanel.tsx`. Mounts the panel directly with
 * stub `onOpen`/`onClose`/`onBack` callbacks (its new contract).
 *
 * The quick-note seam is `quickCaptureDailyNote` → `POST /api/notes/quick-capture`,
 * stubbed at the fetch boundary (no vi.mock of internal modules). Obsolete tray-only
 * cases (OPEN_ADD_CONTENT_EVENT open, window-paste, mobile-sheet popstate) belong to
 * the Launcher surface and are covered by `Launcher.test.tsx`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import {
  createOutlineDocFromBlock,
  paragraphFromText,
} from "@/lib/notes/prosemirror/schema";
import type { StoredNoteEditorDraft } from "@/lib/notes/useNoteEditorSession";
import type { LauncherActionTarget } from "@/lib/launcher/model";
import CreatePanel from "./CreatePanel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

// The quick-capture endpoint carries a ?time_zone= query, so match by pathname.
function quickCaptureBodies(
  fetchMock: ReturnType<typeof stubQuickCapture>,
): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const url = new URL(String(input), "http://localhost");
      return url.pathname === "/api/notes/quick-capture" && init?.method === "POST";
    })
    .map(([, init]) => parseJsonBody(init));
}

function stubQuickCapture() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/notes/quick-capture" && init?.method === "POST") {
      const body = parseJsonBody(init);
      return jsonResponse({
        data: {
          id: String(body.id ?? "block-new"),
          page_id: "page-today",
          parent_block_id: null,
          order_key: "a",
          body_pm_json: body.body_pm_json ?? { type: "paragraph" },
          body_text: "captured text",
          collapsed: false,
          children: [],
        },
      });
    }
    throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
  });
}

function renderCreatePanel(): {
  onOpen: ReturnType<typeof vi.fn<(target: LauncherActionTarget) => void>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
  onBack: ReturnType<typeof vi.fn<() => void>>;
} {
  const onOpen = vi.fn<(target: LauncherActionTarget) => void>();
  const onClose = vi.fn<() => void>();
  const onBack = vi.fn<() => void>();
  render(
    withRenderEnvironment(
      <FeedbackProvider>
        <CreatePanel onOpen={onOpen} onClose={onClose} onBack={onBack} />
      </FeedbackProvider>,
    ),
  );
  return { onOpen, onClose, onBack };
}

// Pre-store a recoverable draft under the CreatePanel resource key.
function storeNoteDraft(
  resourceKey: string,
  draft: Omit<StoredNoteEditorDraft, "version" | "doc" | "updatedAt"> & { doc: unknown },
): void {
  window.localStorage.setItem(
    `nexus.noteDraft:${resourceKey}`,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...draft,
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("innerWidth", 1280);
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CreatePanel", () => {
  it("renders the quick-note editor and the New note back header", () => {
    stubQuickCapture();
    renderCreatePanel();

    expect(screen.getByRole("textbox", { name: "Quick note to today" })).toBeInTheDocument();
    expect(screen.getByText("New note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open today" })).toBeInTheDocument();
  });

  it("flushes the typed draft and routes to today via onOpen then onClose on 'Open today'", async () => {
    const user = userEvent.setup();
    const fetchMock = stubQuickCapture();
    const { onOpen, onClose } = renderCreatePanel();

    const editor = screen.getByRole("textbox", { name: "Quick note to today" });
    await user.click(editor);
    await user.keyboard("captured text");
    fireEvent.click(screen.getByRole("button", { name: "Open today" }));

    // The dispatch contract: open the daily note, then dismiss the launcher.
    expect(onOpen).toHaveBeenCalledWith({
      kind: "href",
      href: "/daily",
      externalShell: false,
      titleHint: "Today",
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // "Open today" flushes the pending draft to the quick-capture endpoint.
    await waitFor(() => {
      expect(quickCaptureBodies(fetchMock)).toContainEqual(
        expect.objectContaining({
          body_pm_json: paragraphFromText("captured text").toJSON(),
        }),
      );
    });
  });

  it("routes to today even with an empty editor and does not POST a quick capture", async () => {
    const fetchMock = stubQuickCapture();
    const { onOpen, onClose } = renderCreatePanel();

    fireEvent.click(screen.getByRole("button", { name: "Open today" }));

    expect(onOpen).toHaveBeenCalledWith({
      kind: "href",
      href: "/daily",
      externalShell: false,
      titleHint: "Today",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Nothing to flush: an empty quick note must not create a daily block.
    expect(quickCaptureBodies(fetchMock)).toHaveLength(0);
  });

  it("recovers a stored draft and saves it with its stored identity on Save", async () => {
    const user = userEvent.setup();
    const fetchMock = stubQuickCapture();
    const draftDoc = createOutlineDocFromBlock({
      id: "recovered-quick-block",
      bodyPmJson: paragraphFromText("offline quick note").toJSON() as Record<string, unknown>,
      bodyText: "offline quick note",
    });
    storeNoteDraft("quick-note:daily", {
      doc: draftDoc.toJSON(),
      metadata: null,
      sequence: 6,
      clientMutationId: "quick-note-recovered-cmid",
    });

    renderCreatePanel();

    const editor = await screen.findByRole("textbox", { name: "Quick note to today" });
    expect(editor).toHaveTextContent("offline quick note");
    expect(await screen.findByText("Recovered unsaved changes")).toBeInTheDocument();
    // Recovery alone must not POST until the user confirms.
    expect(quickCaptureBodies(fetchMock)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(quickCaptureBodies(fetchMock)).toContainEqual(
        expect.objectContaining({
          id: "recovered-quick-block",
          client_mutation_id: "quick-note-recovered-cmid",
          body_pm_json: paragraphFromText("offline quick note").toJSON(),
        }),
      );
    });
  });

  it("discards a recovered draft, clearing the recovery notice without saving", async () => {
    const user = userEvent.setup();
    const fetchMock = stubQuickCapture();
    const draftDoc = createOutlineDocFromBlock({
      id: "recovered-quick-block",
      bodyPmJson: paragraphFromText("offline quick note").toJSON() as Record<string, unknown>,
      bodyText: "offline quick note",
    });
    storeNoteDraft("quick-note:daily", {
      doc: draftDoc.toJSON(),
      metadata: null,
      sequence: 6,
      clientMutationId: "quick-note-recovered-cmid",
    });

    renderCreatePanel();

    expect(await screen.findByText("Recovered unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.queryByText("Recovered unsaved changes")).not.toBeInTheDocument();
    });
    expect(quickCaptureBodies(fetchMock)).toHaveLength(0);
    expect(window.localStorage.getItem("nexus.noteDraft:quick-note:daily")).toBeNull();
  });

  it("invokes onBack when the New note header is pressed", () => {
    stubQuickCapture();
    const { onBack } = renderCreatePanel();

    fireEvent.click(screen.getByText("New note"));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
